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

import { assertKnownProducts, type ProductCatalogue } from '../config/products.js';
import { UnreadableAnswerError } from '../models/provider.js';
import type { ModelProvider } from '../models/provider.js';
import { indexDocument } from '../retriever/retriever.js';
import type { DocKind, IndexedDoc } from '../retriever/types.js';
import { errorMessage } from '../errors.js';

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

/**
 * DEC-47: the products a document serves. Optional, because a document that
 * names none serves every product — so a file that omits the line is
 * complete rather than missing a field.
 */
const OPTIONAL_FIELDS = ['products'] as const;

export interface DocumentFrontmatter {
  docId: string;
  kind: DocKind;
  title: string;
  owner: string;
  /** ISO calendar date (YYYY-MM-DD), stored verbatim. */
  reviewBy: string;
  /**
   * DEC-47: the products this document serves, comma separated in the
   * frontmatter. Empty means every product, and it is what a file that
   * names none declares.
   */
  products: readonly string[];
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
  const known = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
  for (const key of fields.keys()) {
    if (!known.includes(key as (typeof known)[number])) {
      throw new Error(
        `unknown frontmatter field: ${key} (allowed: ${known.join(', ')})`,
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

  // DEC-47: the products, comma separated. A blank item is refused by name
  // rather than dropped: `products: aurora,` is a typo, and a dropped empty
  // item would silently narrow the scope the operator wrote.
  const rawProducts = (fields.get('products') ?? '').trim();
  const products =
    rawProducts === '' ? [] : rawProducts.split(',').map((product) => product.trim());
  if (products.some((product) => product === '')) {
    throw new Error(`products must be a comma-separated list with no empty item, got "${rawProducts}"`);
  }

  return {
    frontmatter: { docId, kind, title, owner, reviewBy, products },
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

/** The refusal a vector of the wrong size gets, from the loader and the consumer alike. */
export function dimensionMismatch(columnDim: number, actualDim: number, modelVer: string): Error {
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
        `${errorMessage(err)}`,
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
/** A file that passed validation, with the text the model embeds. */
interface PendingFile {
  file: string;
  text: string;
  doc: IndexedDoc;
}

export async function loadKbDirectory(
  pool: Pool,
  provider: ModelProvider,
  dir: string,
  embedModelVer: string,
  catalogue: ProductCatalogue,
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
  const docs: PendingFile[] = [];
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
      // DEC-47: a document naming a product the catalogue does not hold is
      // retrieved by nobody — the filter keeps a run's own product's
      // documents and the unscoped ones — so the fault is refused here, by
      // name, rather than met later as an answer that silently missed its
      // source. Per file, like every other frontmatter fault: the run
      // continues and reports it.
      assertKnownProducts(catalogue, frontmatter.products, frontmatter.docId);
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
          products: frontmatter.products,
        },
      });
    } catch (err) {
      report.failed += 1;
      report.failures.push(`${name}: ${errorMessage(err)}`);
    }
  }

  // DEC-50: a document a reviewer wrote in the console keeps its id. Found
  // before the embedding call, so a reload pays for no file it will not
  // write. The index step below still refuses one written in the meantime.
  let held: { rows: { doc_id: string }[] };
  try {
    held = await pool.query<{ doc_id: string }>(
      "SELECT doc_id FROM document WHERE source = 'console' AND doc_id = ANY($1::text[])",
      [docs.map((d) => d.doc.docId)],
    );
  } catch (err) {
    // A ledger without db/034 has no `source` column. Named, so the operator
    // runs the migration rather than reading a bare Postgres error.
    const code = (err as { code?: unknown }).code;
    if (code === '42703' || code === '42P01') {
      throw new Error(`the document table predates db/034; run pnpm run db:migrate first (${errorMessage(err)})`);
    }
    throw err;
  }
  const heldIds = new Set(held.rows.map((row) => row.doc_id));
  for (const item of docs.filter((d) => heldIds.has(d.doc.docId))) reportHeld(report, item);
  const toEmbed = docs.filter((d) => !heldIds.has(d.doc.docId));

  try {
    await embedAndIndex(pool, provider, toEmbed, embedModelVer, columnDim, report);
  } catch (err) {
    // A batch that fails after others were paid for and written says so, so
    // the operator reads what the run did before it stopped (DEC-25).
    throw new Error(
      `${errorMessage(err)} (before this, ${report.indexed} documents were indexed at a cost of`
        + ` ${report.costMicros} micro-dollars)`,
    );
  }

  return report;
}

/** Embeds the documents in batches and indexes each one. */
async function embedAndIndex(
  pool: Pool,
  provider: ModelProvider,
  toEmbed: readonly PendingFile[],
  embedModelVer: string,
  columnDim: number,
  report: LoadReport,
): Promise<void> {
  for (let start = 0; start < toEmbed.length; start += EMBED_BATCH) {
    const batch = toEmbed.slice(start, start + EMBED_BATCH);
    let result: Awaited<ReturnType<ModelProvider['embed']>>;
    try {
      result = await provider.embed({
        input: batch.map((d) => d.text),
        promptVer: PROMPT_VER,
        modelVer: embedModelVer,
      });
    } catch (err) {
      // An answer the provider could not read was still paid for (DEC-25),
      // so the report the error carries counts it.
      if (err instanceof UnreadableAnswerError) report.costMicros += err.costMicros;
      throw err;
    }
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
      const outcome = await indexDocument(pool, item.doc, vector, embedModelVer);
      if (outcome === 'held_by_console') {
        reportHeld(report, item);
        continue;
      }
      report.indexed += 1;
    }
  }
}

/**
 * DEC-50: a reviewer wrote a document with this id in the console. The
 * loader leaves it as it is and says so, per file, as it reports every other
 * fault it does not stop for.
 */
function reportHeld(report: LoadReport, item: { file: string; doc: { docId: string } }): void {
  report.failed += 1;
  report.failures.push(
    `${item.file}: a document written in the console holds doc_id "${item.doc.docId}";`
      + ' the loader leaves it as it is',
  );
}
