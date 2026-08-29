// Knowledge-base loader core (Phase 2, approved decisions D4-A + D5-A).
//
// Reads a directory of markdown files with YAML frontmatter, validates the
// DEC-22/DEC-23 metadata, strips markdown to plain text, embeds through the
// one model provider and upserts through indexDocument. There is no second
// storage path: everything lands in the section 4.6 document table.
//
// Failure policy: a file with bad frontmatter fails loudly. The run continues
// with the remaining files, prints every failure and reports counts. Nothing
// skips silently. Dimension drift is a different failure class: it poisons
// every row silently, so it aborts the whole run before any upsert.
//
// Decisions obeyed: DEC-22 (kinds), DEC-23 (owner + review_by), DEC-25
// (truthful embedding cost via embeddingsUsdPerMTok), DEC-26 (pinned model).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

import type { ModelProvider } from '../models/provider.js';
import { indexDocument } from '../retriever/retriever.js';
import type { DocKind, IndexedDoc } from '../retriever/types.js';

export const DEFAULT_EMBED_MODEL = 'openai/text-embedding-3-small';

const PROMPT_VER = 'load-docs-v1';

/** Documents per embed() call. Bounds request size; semantics are unchanged. */
const EMBED_BATCH = 64;

/**
 * Known output dimensions for the dimension checks. A model not listed here
 * still gets the live column check after the first embed() call.
 */
const KNOWN_EMBED_DIMS: Readonly<Record<string, number>> = {
  'openai/text-embedding-3-small': 1536,
  'openai/text-embedding-3-large': 3072,
};

const REQUIRED_FIELDS = ['doc_id', 'kind', 'title', 'owner', 'review_by'] as const;

export interface DocumentFrontmatter {
  docId: string;
  kind: DocKind;
  title: string;
  owner: string;
  /** ISO calendar date (YYYY-MM-DD), stored verbatim. */
  reviewBy: string;
}

export interface LoadReport {
  indexed: number;
  skipped: number;
  failed: number;
  /** One human-readable line per failed file, in directory order. */
  failures: string[];
  /** DEC-25: truthful embedding cost for this run, integer micro-dollars. */
  costMicros: number;
}

export function parseFrontmatter(raw: string): {
  frontmatter: DocumentFrontmatter;
  markdownBody: string;
} {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error('file does not start with a --- frontmatter block');
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) {
    throw new Error('frontmatter block is never closed');
  }

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, close)) {
    if (line.trim() === '') {
      continue;
    }
    const sep = line.indexOf(':');
    if (sep <= 0) {
      throw new Error(`malformed frontmatter line: "${line.trim()}"`);
    }
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) {
      value = value.slice(1, -1);
    }
    if (fields.has(key)) {
      throw new Error(`duplicate frontmatter field: ${key}`);
    }
    fields.set(key, value);
  }

  for (const field of REQUIRED_FIELDS) {
    if (!fields.has(field)) {
      throw new Error(`missing frontmatter field: ${field}`);
    }
  }
  for (const key of fields.keys()) {
    if (!REQUIRED_FIELDS.includes(key as (typeof REQUIRED_FIELDS)[number])) {
      throw new Error(
        `unknown frontmatter field: ${key} (allowed: ${REQUIRED_FIELDS.join(', ')})`,
      );
    }
  }

  const docId = fields.get('doc_id') ?? '';
  if (docId.length === 0 || /\s/.test(docId)) {
    throw new Error('doc_id must be non-empty and contain no whitespace');
  }

  // Frontmatter speaks the card's vocabulary ('resolution'); the ledger
  // stores the DEC-22 kind ('canonical_resolution').
  const rawKind = fields.get('kind') ?? '';
  let kind: DocKind;
  if (rawKind === 'document') {
    kind = 'document';
  } else if (rawKind === 'resolution') {
    kind = 'canonical_resolution';
  } else {
    throw new Error(`kind must be "document" or "resolution", got "${rawKind}"`);
  }

  const title = fields.get('title') ?? '';
  if (title.trim().length === 0) {
    throw new Error('title must be non-empty');
  }
  const owner = fields.get('owner') ?? '';
  if (owner.trim().length === 0) {
    throw new Error('owner must be non-empty (DEC-23)');
  }

  const reviewBy = fields.get('review_by') ?? '';
  assertIsoDate(reviewBy);

  return {
    frontmatter: { docId, kind, title, owner, reviewBy },
    markdownBody: lines.slice(close + 1).join('\n'),
  };
}

function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`review_by must be an ISO date YYYY-MM-DD, got "${value}"`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`review_by is not a real calendar date: "${value}"`);
  }
}

/**
 * Reduces markdown to plain text for the body column. Fenced code keeps its
 * contents but loses its markers; links keep their text; emphasis markers,
 * table pipes and list bullets disappear. Whitespace collapses.
 */
export function stripMarkdown(markdown: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      let stripped = line.replace(/^\s{0,3}#{1,6}\s+/, '');
      stripped = stripped.replace(/^\s{0,3}>\s?/, '');
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(stripped)) {
        continue; // horizontal rule
      }
      stripped = stripped.replace(/^\s*[-*+]\s+/, '');
      stripped = stripped.replace(/^\s*\d+[.)]\s+/, '');
      kept.push(stripped);
    } else {
      kept.push(line);
    }
  }

  return kept
    .join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/__/g, '')
    .replace(/\|/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Pre-flight check: the vector(N) pin in db/002_documents.sql must match the
 * chosen embedding model whenever that model's output size is known. The DDL
 * comment says a change of model needs a new column and a reindex, so a
 * mismatch here is an instruction to fix one side — never a silent insert.
 */
export function assertDdlDimensionCompat(ddlSql: string, modelVer: string): void {
  const match = /embedding\s+vector\s*\(\s*(\d+)\s*\)/.exec(ddlSql);
  if (!match || match[1] === undefined) {
    throw new Error('db/002_documents.sql declares no vector(N) embedding column');
  }
  const ddlDim = Number(match[1]);
  const known = KNOWN_EMBED_DIMS[modelVer];
  if (known === undefined) {
    return;
  }
  if (known !== ddlDim) {
    throw dimensionMismatch(ddlDim, known, modelVer);
  }
}

function dimensionMismatch(columnDim: number, actualDim: number, modelVer: string): Error {
  return new Error(
    `dimension mismatch: the document.embedding column holds vector(${columnDim}) ` +
      `but ${modelVer} emits ${actualDim} dimensions. Change the DDL (new column ` +
      `and reindex) or pick a matching EMBED_MODEL_VER.`,
  );
}

/** Live dimension of document.embedding straight from the catalog. */
export async function documentEmbeddingColumnDim(pool: Pool): Promise<number> {
  let rows: { atttypmod: number | null }[];
  try {
    const result = await pool.query<{ atttypmod: number | null }>(
      `SELECT atttypmod FROM pg_attribute
       WHERE attrelid = 'document'::regclass AND attname = 'embedding'`,
    );
    rows = result.rows;
  } catch (err) {
    throw new Error(
      `cannot read document.embedding dimension (run pnpm run db:migrate first): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const row = rows[0];
  if (row === undefined || row.atttypmod === null || row.atttypmod <= 0) {
    throw new Error('document.embedding has no pinned dimension; run pnpm run db:migrate');
  }
  return row.atttypmod;
}

/**
 * Loads every *.md file in `dir`. Returns per-run counts; per-file validation
 * errors land in report.failures (also meant for stderr). Hard failures —
 * dimension drift between provider output and the column — throw instead,
 * because continuing would poison the index silently.
 */
export async function loadKbDirectory(
  pool: Pool,
  provider: ModelProvider,
  dir: string,
  embedModelVer: string,
): Promise<LoadReport> {
  const ddlPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../db/002_documents.sql',
  );
  assertDdlDimensionCompat(await readFile(ddlPath, 'utf8'), embedModelVer);

  const columnDim = await documentEmbeddingColumnDim(pool);
  const known = KNOWN_EMBED_DIMS[embedModelVer];
  if (known !== undefined && known !== columnDim) {
    throw dimensionMismatch(columnDim, known, embedModelVer);
  }

  const dirents = [...(await readdir(dir, { withFileTypes: true }))].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const mdFiles = dirents
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => d.name);
  const report: LoadReport = {
    indexed: 0,
    skipped: dirents.length - mdFiles.length,
    failed: 0,
    failures: [],
    costMicros: 0,
  };

  const seenIds = new Map<string, string>();
  const docs: { file: string; text: string; doc: IndexedDoc }[] = [];
  for (const name of mdFiles) {
    try {
      const raw = await readFile(path.join(dir, name), 'utf8');
      const { frontmatter, markdownBody } = parseFrontmatter(raw);
      const firstOwner = seenIds.get(frontmatter.docId);
      if (firstOwner !== undefined) {
        throw new Error(
          `duplicate doc_id "${frontmatter.docId}" (first seen in ${firstOwner})`,
        );
      }
      seenIds.set(frontmatter.docId, name);
      docs.push({
        file: name,
        text: `${frontmatter.title}\n\n${stripMarkdown(markdownBody)}`,
        doc: {
          docId: frontmatter.docId,
          kind: frontmatter.kind,
          title: frontmatter.title,
          body: stripMarkdown(markdownBody),
          owner: frontmatter.owner,
          reviewBy: frontmatter.reviewBy,
        },
      });
    } catch (err) {
      report.failed += 1;
      report.failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (let start = 0; start < docs.length; start += EMBED_BATCH) {
    const batch = docs.slice(start, start + EMBED_BATCH);
    const result = await provider.embed({
      input: batch.map((d) => d.text),
      promptVer: PROMPT_VER,
      modelVer: embedModelVer,
    });
    report.costMicros += result.costMicros;
    if (result.vectors.length !== batch.length) {
      throw new Error(
        `provider returned ${result.vectors.length} vectors for ${batch.length} documents`,
      );
    }
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const vector = result.vectors[i];
      if (item === undefined || vector === undefined) {
        throw new Error('provider returned fewer vectors than inputs');
      }
      if (vector.length !== columnDim) {
        throw dimensionMismatch(columnDim, vector.length, embedModelVer);
      }
      await indexDocument(pool, item.doc, vector);
      report.indexed += 1;
    }
  }

  return report;
}
