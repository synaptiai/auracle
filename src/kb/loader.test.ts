// Unit tests for the knowledge-base loader: frontmatter validation, markdown
// stripping and the dimension pre-flight checks. No database, no network.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EMBED_MODEL,
  assertDdlDimensionCompat,
  parseFrontmatter,
  stripMarkdown,
} from './loader.js';

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');
const DDL = readFileSync(path.join(dbDir, '002_documents.sql'), 'utf8');

function frontmatterOf(body: string): string {
  return `---\ndoc_id: kb-001\nkind: document\ntitle: Reset passwords\nowner: support-docs\nreview_by: 2999-01-01\n---\n${body}`;
}

describe('parseFrontmatter', () => {
  it('parses a valid document file', () => {
    const { frontmatter, markdownBody } = parseFrontmatter(
      frontmatterOf('# Steps\n\nOpen the login page.'),
    );
    expect(frontmatter).toEqual({
      docId: 'kb-001',
      kind: 'document',
      title: 'Reset passwords',
      owner: 'support-docs',
      reviewBy: '2999-01-01',
    });
    expect(markdownBody).toBe('# Steps\n\nOpen the login page.');
  });

  it('maps resolution to the DEC-22 canonical_resolution kind', () => {
    const raw = frontmatterOf('body').replace('kind: document', 'kind: resolution');
    expect(parseFrontmatter(raw).frontmatter.kind).toBe('canonical_resolution');
  });

  it('accepts quoted values and blank lines inside the block', () => {
    const raw = [
      '---',
      'doc_id: "kb-002"',
      "kind: 'resolution'",
      'title: Refund policy',
      '',
      'owner: billing-docs',
      'review_by: 2999-06-30',
      '---',
      'body text',
    ].join('\n');
    const parsed = parseFrontmatter(raw);
    expect(parsed.frontmatter.docId).toBe('kb-002');
    expect(parsed.frontmatter.kind).toBe('canonical_resolution');
  });

  it('rejects each missing required field by name', () => {
    for (const field of ['doc_id', 'kind', 'title', 'owner', 'review_by']) {
      const lines = frontmatterOf('x')
        .split('\n')
        .filter((line) => !line.startsWith(`${field}:`));
      expect(() => parseFrontmatter(lines.join('\n'))).toThrowError(
        new RegExp(`missing frontmatter field: ${field}`),
      );
    }
  });

  it('rejects an unknown kind loudly (DEC-22)', () => {
    const raw = frontmatterOf('x').replace('kind: document', 'kind: ticket_dump');
    expect(() => parseFrontmatter(raw)).toThrowError(
      /kind must be "document" or "resolution"/,
    );
  });

  it('rejects an unknown field so a typo never silently drops data', () => {
    const raw = `${frontmatterOf('x').replace('---\n', '---\nreviewd_by: 2999-01-01\n')}`;
    expect(() => parseFrontmatter(raw)).toThrowError(/unknown frontmatter field: reviewd_by/);
  });

  it('rejects a bad review_by date format and impossible dates', () => {
    for (const bad of ['tomorrow', '2024-13-40', '2024-02-30']) {
      const raw = frontmatterOf('x').replace('review_by: 2999-01-01', `review_by: ${bad}`);
      expect(() => parseFrontmatter(raw)).toThrowError(/review_by/);
    }
  });

  it('rejects an unclosed block, a non-scalar line, duplicates and empty ids', () => {
    expect(() => parseFrontmatter('---\ndoc_id: x\n')).toThrowError(/never closed/);
    expect(() =>
      parseFrontmatter(
        '---\ndoc_id: x\nthis line has no colon at all\nkind: document\n---\n',
      ),
    ).toThrowError(/malformed frontmatter line/);
    // An indented "key: value" line is still scalar syntax; the unknown-field
    // check catches it once required fields are validated.
    expect(() =>
      parseFrontmatter(
        '---\ndoc_id: x\n  nested: value\nkind: document\ntitle: t\nowner: o\nreview_by: 2999-01-01\n---\n',
      ),
    ).toThrowError(/unknown frontmatter field: nested/);
    expect(() =>
      parseFrontmatter(
        '---\ndoc_id: x\ndoc_id: y\nkind: document\ntitle: t\nowner: o\nreview_by: 2999-01-01\n---\n',
      ),
    ).toThrowError(/duplicate frontmatter field: doc_id/);
    expect(() =>
      parseFrontmatter(
        '---\ndoc_id: two words\nkind: document\ntitle: t\nowner: o\nreview_by: 2999-01-01\n---\n',
      ),
    ).toThrowError(/doc_id/);
  });
});

describe('stripMarkdown', () => {
  it('strips headings, emphasis markers, list bullets and links', () => {
    const md = [
      '# Password reset',
      '',
      'Use the **reset page** or *email flow*.',
      '- step one',
      '1. step two',
      'See [the guide](https://example.com/guide) for details.',
    ].join('\n');
    expect(stripMarkdown(md)).toBe(
      'Password reset\n\nUse the reset page or email flow.\nstep one\nstep two\nSee the guide for details.',
    );
  });

  it('keeps fenced code contents but drops fence markers and inline markup', () => {
    const md = 'Run this:\n\n```bash\nnpm run load-docs -- docs/\n```\n\nThen check `status`.';
    expect(stripMarkdown(md)).toContain('npm run load-docs -- docs/');
    expect(stripMarkdown(md)).not.toContain('```');
    expect(stripMarkdown(md)).toContain('Then check status.');
  });

  it('removes images, blockquote markers, rules and table pipes', () => {
    const md = '> quoted advice\n\n![logo](logo.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const out = stripMarkdown(md);
    expect(out).not.toContain('>'); 
    expect(out).not.toContain('|');
    expect(out).not.toContain('logo.png');
    expect(out).toContain('quoted advice');
    expect(out).toContain('1 2');
  });

  it('collapses runs of blank lines', () => {
    expect(stripMarkdown('a\n\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('assertDdlDimensionCompat', () => {
  it('accepts the shipped DDL with the default model (both 1536)', () => {
    expect(() => assertDdlDimensionCompat(DDL, DEFAULT_EMBED_MODEL)).not.toThrow();
  });

  it('throws when the known model size disagrees with vector(N)', () => {
    expect(() =>
      assertDdlDimensionCompat(DDL, 'openai/text-embedding-3-large'),
    ).toThrowError(/dimension mismatch.*vector\(1536\).*3072/s);
  });

  it('skips the static check for unknown models but still requires a pin in the DDL', () => {
    expect(() =>
      assertDdlDimensionCompat(DDL, 'vendor/custom-embedder'),
    ).not.toThrow();
    expect(() =>
      assertDdlDimensionCompat('CREATE TABLE document (body text);', DEFAULT_EMBED_MODEL),
    ).toThrowError(/no vector\(N\) embedding column/);
  });
});
