/**
 * MIME / RFC 5322 normalization for the IMAP/SMTP reference adapter.
 *
 * Dependency-free parser for the subset of MIME that support mail uses:
 * header unfolding, quoted-printable and base64 transfer encodings, and
 * the multipart/mixed and multipart/alternative trees. Text is decoded
 * as UTF-8. The parser reads synthetic fixtures only (DEC-18).
 */

import type { Attachment } from './types.js';

const utf8 = new TextDecoder('utf-8', { fatal: false });

/** Map.get returns undefined for absent keys; headers are null-based. */
function headerOf(headers: Map<string, string>, name: string): string | null {
  return headers.get(name) ?? null;
}

interface LeafPart {
  contentType: string;
  filename: string | null;
  isAttachment: boolean;
  bodyBytes: Uint8Array;
}

interface ParsedPart {
  headers: Map<string, string>;
  body: string;
}

function unfoldHeaders(headerBlock: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = headerBlock.split(/\r?\n/);
  let currentName: string | null = null;
  let currentValue = '';

  const commit = (): void => {
    if (currentName !== null) {
      headers.set(currentName.toLowerCase(), currentValue.trim());
    }
    currentName = null;
    currentValue = '';
  };

  for (const line of lines) {
    if (line.length === 0) continue;
    // A line starting with whitespace continues the previous header value.
    if ((line.startsWith(' ') || line.startsWith('\t')) && currentName !== null) {
      currentValue += ` ${line.trim()}`;
      continue;
    }
    commit();
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    currentName = line.slice(0, colon).trim();
    currentValue = line.slice(colon + 1);
  }
  commit();
  return headers;
}

function splitHeaderBody(raw: string): ParsedPart {
  const match = /\r?\n\r?\n/.exec(raw);
  if (match === null || match.index === undefined) {
    return { headers: unfoldHeaders(raw), body: '' };
  }
  return {
    headers: unfoldHeaders(raw.slice(0, match.index)),
    body: raw.slice(match.index + match[0].length),
  };
}

/** Parse a Content-Type style header into a media type and lowercase params. */
function parseContentType(
  value: string,
): { type: string; params: Record<string, string> } {
  const segments = splitHeaderParams(value);
  const type = (segments[0] ?? '').trim().toLowerCase() || 'text/plain';
  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    let param = segment.slice(eq + 1).trim();
    if (param.startsWith('"') && param.endsWith('"')) {
      param = param.slice(1, -1);
    }
    params[key] = param;
  }
  return { type, params };
}

/**
 * Split a header value on ';' but keep ';' inside quoted strings intact
 * (filenames and boundary values may contain them).
 */
function splitHeaderParams(value: string): string[] {
  const segments: string[] = [];
  let inQuotes = false;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ';' && !inQuotes) {
      segments.push(value.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(value.slice(start));
  return segments;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split a multipart body into its parts.
 *
 * Content before the first boundary is the preamble and is dropped;
 * content between consecutive boundary lines becomes one raw part each.
 * The closing boundary terminates the collection.
 */
function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = new RegExp(
    `(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*(?=\\r?\\n|$)`,
    'g',
  );
  const matches = [...body.matchAll(delimiter)];
  const parts: string[] = [];
  for (let i = 0; i < matches.length - 1; i++) {
    const match = matches[i];
    const nextMatch = matches[i + 1];
    if (match === undefined || nextMatch === undefined) break;
    if (match[1] === '--') break;
    const start = (match.index ?? 0) + match[0].length;
    const end = nextMatch.index ?? body.length;
    parts.push(
      body
        .slice(start, end)
        .replace(/^\r?\n/, '')
        .replace(/\r?\n$/, ''),
    );
  }
  return parts;
}

function decodeQuotedPrintable(input: string): Uint8Array {
  const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const char = withoutSoftBreaks.charAt(i);
    const hexPair = withoutSoftBreaks.slice(i + 1, i + 3);
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(hexPair)) {
      bytes.push(Number.parseInt(hexPair, 16));
      i += 2;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }
  return Uint8Array.from(bytes);
}

function decodeBody(body: string, transferEncoding: string | null): Uint8Array {
  switch ((transferEncoding ?? '').toLowerCase()) {
    case 'quoted-printable':
      return decodeQuotedPrintable(body);
    case 'base64':
      return new Uint8Array(Buffer.from(body.replace(/\s+/g, ''), 'base64'));
    default:
      // 7bit, 8bit, binary and unknown encodings pass through unchanged.
      return new Uint8Array(Buffer.from(body, 'utf8'));
  }
}

/** Walk a parsed part tree, flattening non-multipart leaves. */
function collectLeaves(part: ParsedPart, leaves: LeafPart[]): void {
  const contentTypeHeader = headerOf(part.headers, 'content-type') ?? 'text/plain';
  const { type, params } = parseContentType(contentTypeHeader);

  if (type.startsWith('multipart/')) {
    const boundary = params['boundary'];
    if (boundary === undefined) return;
    for (const rawChild of splitMultipart(part.body, boundary)) {
      collectLeaves(splitHeaderBody(rawChild), leaves);
    }
    return;
  }

  const dispositionHeader = headerOf(part.headers, 'content-disposition');
  const disposition = dispositionHeader !== null ? parseContentType(dispositionHeader) : null;
  // An explicit attachment disposition, or a name param with no disposition
  // at all, marks an attachment. An inline part with a filename does not.
  const isAttachment =
    disposition?.type === 'attachment' ||
    (disposition === null && params['name'] !== undefined);
  const filename = disposition?.params['filename'] ?? params['name'] ?? null;

  leaves.push({
    contentType: type,
    filename,
    isAttachment,
    bodyBytes: decodeBody(part.body, headerOf(part.headers, 'content-transfer-encoding')),
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

/**
 * Decode RFC 2047 encoded words (=?charset?Q/B?...?=) so subjects and
 * address display names arrive as text, not transport bytes. An encoded
 * word the decoder cannot handle passes through unchanged.
 */
export function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (word: string, charset: string, encoding: string, text: string) => {
      try {
        const decoder = new TextDecoder(charset, { fatal: false });
        const bytes =
          encoding.toLowerCase() === 'b'
            ? new Uint8Array(Buffer.from(text.replace(/\s+/g, ''), 'base64'))
            : qEncodingBytes(text);
        return decoder.decode(bytes);
      } catch {
        return word;
      }
    },
  );
}

/** Q encoding: '_' is a space, =XX is one hex-escaped byte. */
function qEncodingBytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === '_') {
      bytes.push(0x20);
      continue;
    }
    const hexPair = text.slice(i + 1, i + 3);
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(hexPair)) {
      bytes.push(Number.parseInt(hexPair, 16));
      i += 2;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }
  return Uint8Array.from(bytes);
}

/** Extract bare addresses from an address header such as From or Cc. */
export function extractAddresses(value: string): string[] {
  const addresses: string[] = [];
  const angleBracket = /<([^<>\s]+@[^\s<>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = angleBracket.exec(value)) !== null) {
    addresses.push(match[1] ?? '');
  }
  if (addresses.length === 0) {
    const bare = /[^\s<>,;"']+@[^\s<>,;"']+/g;
    let bareMatch: RegExpExecArray | null;
    while ((bareMatch = bare.exec(value)) !== null) {
      addresses.push(bareMatch[0]);
    }
  }
  return addresses;
}

export function stripMessageId(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>')
    ? trimmed.slice(1, -1)
    : trimmed;
}

export interface NormalizedEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string | null;
  sentAt: string | null;
  bodyText: string;
  attachments: Attachment[];
}

/**
 * Normalize one RFC 5322 message into port-shaped data.
 *
 * Body selection: the first inline text/plain leaf wins; then any other
 * plain-text leaf; then the first text/html leaf with tags stripped.
 */
export function normalizeMime(raw: string): NormalizedEmail {
  const root = splitHeaderBody(raw);
  const leaves: LeafPart[] = [];
  collectLeaves(root, leaves);

  const inlinePlain = leaves.find((leaf) => leaf.contentType === 'text/plain' && !leaf.isAttachment);
  const anyPlain = leaves.find((leaf) => leaf.contentType === 'text/plain');
  const htmlLeaf = leaves.find((leaf) => leaf.contentType === 'text/html');
  const chosen = inlinePlain ?? anyPlain ?? htmlLeaf ?? null;

  const attachmentLeaves = leaves.filter(
    (leaf) => leaf.isAttachment && leaf !== chosen,
  );
  const attachments = attachmentLeaves.map((leaf) => ({
    filename: leaf.filename,
    contentType: leaf.contentType,
    sizeBytes: leaf.bodyBytes.byteLength,
  }));

  let decoded = chosen === null ? '' : utf8.decode(chosen.bodyBytes);
  if (chosen !== null && chosen.contentType === 'text/html') {
    decoded = stripHtml(decoded);
  }
  const bodyText = decoded.replace(/\r\n/g, '\n').trim();

  const referencesHeader = headerOf(root.headers, 'references');
  const references =
    referencesHeader !== null
      ? referencesHeader.trim().split(/\s+/).map(stripMessageId)
      : [];

  const inReplyTo = headerOf(root.headers, 'in-reply-to');
  const messageId = headerOf(root.headers, 'message-id');

  const decodeHeader = (value: string | null): string | null =>
    value !== null ? decodeEncodedWords(value) : null;

  return {
    messageId: messageId !== null ? stripMessageId(messageId) : null,
    inReplyTo: inReplyTo !== null ? stripMessageId(inReplyTo) : null,
    references,
    fromAddress: firstAddress(decodeHeader(headerOf(root.headers, 'from'))),
    toAddresses: allAddresses(decodeHeader(headerOf(root.headers, 'to'))),
    ccAddresses: allAddresses(decodeHeader(headerOf(root.headers, 'cc'))),
    subject: decodeHeader(headerOf(root.headers, 'subject')),
    sentAt: headerOf(root.headers, 'date'),
    bodyText,
    attachments,
  };
}

function firstAddress(headerValue: string | null): string | null {
  if (headerValue === null) return null;
  return extractAddresses(headerValue)[0] ?? null;
}

function allAddresses(headerValue: string | null): string[] {
  if (headerValue === null) return [];
  return extractAddresses(headerValue);
}
