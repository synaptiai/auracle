// The document reader, against the ledger (DEC-22, DEC-23).
//
// A citation is worth showing only if a person can check it, and checking it
// means two questions: what does the document say, and is that still what the
// run read.
import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl, readerDbUrl } from '../db/config.js';
import { truncateLedger } from '../test-support/schema.js';
import { indexDocument } from '../retriever/retriever.js';
import { readRunJournal } from '../journal/query.js';
import { readDocument } from './query.js';

const pool = new Pool({ connectionString: dbUrl(), max: 4 });
// The readers connect as the role that cannot act beyond a read (issue #153).
const readers = new Pool({ connectionString: readerDbUrl(), max: 4 });
const EMBEDDING = Array.from({ length: 1536 }, () => 0);

afterAll(async () => {
  await readers.end();
  await pool.end();
});


beforeEach(async () => {
  await truncateLedger(pool);
});

async function index(
  docId: string,
  body: string,
  reviewBy: string,
  products?: string[],
): Promise<void> {
  await indexDocument(
    pool,
    {
      docId,
      kind: 'document',
      title: 'Refund eligibility windows',
      body,
      owner: 'billing-team',
      reviewBy,
      ...(products === undefined ? {} : { products }),
    },
    EMBEDDING,
  );
}

describe('a document a claim cited', () => {
  it('returns what it says, so a person can check the citation', async () => {
    await index('SYN-1', 'A charge is refundable inside fourteen days.', '2030-01-01');
    const doc = await readDocument(readers, 'SYN-1');
    expect(doc?.body).toBe('A charge is refundable inside fourteen days.');
    expect(doc?.title).toBe('Refund eligibility windows');
    expect(doc?.owner).toBe('billing-team');
    expect(doc?.reviewBy).toBe('2030-01-01');
    expect(doc?.kind).toBe('document');
  });

  // DEC-47: the products a document serves. Empty means every product, and
  // that is the answer for a document nobody scoped — so the reader has to
  // return the value rather than a default it invented.
  it('says which products the document serves (DEC-47)', async () => {
    await index('SYN-SCOPED', 'Only for one product.', '2030-01-01', ['aurora', 'ledger']);
    await index('SYN-UNSCOPED', 'For anybody.', '2030-01-01');
    expect((await readDocument(readers, 'SYN-SCOPED'))?.products).toEqual(['aurora', 'ledger']);
    expect((await readDocument(readers, 'SYN-UNSCOPED'))?.products).toEqual([]);
  });

  // A run journals the ids it retrieved, and a document can leave the index
  // afterwards. So a citation pointing at nothing is a state an operator will
  // meet, and it is the document that is gone rather than the run that was
  // wrong.
  it('answers null for an id the index no longer holds', async () => {
    expect(await readDocument(readers, 'SYN-GONE')).toBeNull();
  });

  // The retriever filters on `review_by >= CURRENT_DATE`, and this is that
  // same comparison, made in the database against its own clock — so a
  // console in another timezone cannot disagree with the retriever.
  it('says whether the document is still inside its review window (DEC-23)', async () => {
    await index('SYN-FRESH', 'current guidance', '2030-01-01');
    await index('SYN-STALE', 'guidance nobody has reviewed', '2020-01-01');
    expect((await readDocument(readers, 'SYN-FRESH'))?.fresh).toBe(true);
    expect((await readDocument(readers, 'SYN-STALE'))?.fresh).toBe(false);
  });
});

describe('whether a document moved since the run cited it', () => {
  // Asserted through the path that ships. An earlier version compared in
  // TypeScript here and in SQL in the reader, and its test compared the
  // unused one — so the two could disagree, and did.
  async function retrieveRun(docId: string, recordedHash: string): Promise<string> {
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, 'retrieve', 'done', $2::jsonb, 'p', 'm', 0)`,
      [runId, JSON.stringify({
        docIds: [docId],
        embed_model_ver: 'e1',
        documents: [{
          docId, title: 'Refund eligibility windows', owner: 'billing-team',
          reviewBy: '2030-01-01', bodyHash: recordedHash,
        }],
      })],
    );
    return runId;
  }

  async function digestOf(docId: string): Promise<string> {
    const { rows } = await pool.query(
      "SELECT encode(sha256(convert_to(body, 'UTF8')), 'hex') AS h FROM document WHERE doc_id = $1",
      [docId],
    );
    return (rows[0] as { h: string }).h;
  }

  it('says it did not when the body still matches', async () => {
    await index('SYN-1', 'A charge is refundable inside fourteen days.', '2030-01-01');
    const runId = await retrieveRun('SYN-1', await digestOf('SYN-1'));
    const doc = (await readRunJournal(readers, runId))?.documents?.[0];
    expect(doc?.bodyUnchanged).toBe(true);
  });

  it('says it did when the body has been rewritten', async () => {
    await index('SYN-1', 'the original text', '2030-01-01');
    const runId = await retrieveRun('SYN-1', await digestOf('SYN-1'));
    // Reindexed in place, which is what `indexDocument` does.
    await index('SYN-1', 'the text somebody replaced it with', '2030-01-01');
    const doc = (await readRunJournal(readers, runId))?.documents?.[0];
    expect(doc?.bodyUnchanged).toBe(false);
  });

  // The writer digests in Node and the reader in SQL, so the two must agree
  // byte for byte. Unicode is one axis and it is not the one that broke: the
  // statement used `body::bytea`, an I/O conversion that parses the text as
  // bytea escape syntax. A body holding a Windows path raised `invalid input
  // syntax for type bytea` and took the whole run-detail read with it, and a
  // body that happened to be valid escape syntax digested as the decoded
  // bytes and reported a document changed that never did.
  const bodies: readonly (readonly [string, string])[] = [
    ['a unicode dash and an accent', 'text with a unicode dash — and an accent é'],
    ['a windows path and a regex', 'set PATH to C:\\Users\\ada, then match /\\d+/'],
    ['text that is itself valid escape syntax', '\\x414243'],
    ['a lone backslash', 'ends with \\'],
  ];

  for (const [name, body] of bodies) {
    it(`agrees with the digest the writer computes: ${name}`, async () => {
      await index('SYN-1', body, '2030-01-01');
      // The writer's own digest, computed the way `digestOf` in the
      // coordinator computes it.
      const written = createHash('sha256').update(body, 'utf8').digest('hex');
      const runId = await retrieveRun('SYN-1', written);
      const doc = (await readRunJournal(readers, runId))?.documents?.[0];
      expect((await readDocument(readers, 'SYN-1'))?.body, name).toBe(body);
      expect(doc?.bodyUnchanged, name).toBe(true);
    });
  }

  // Three answers, not two. Null is the question being unanswerable, and a
  // surface that rendered it as "unchanged" would vouch for a document
  // nothing compared.
  it('says nothing when the run recorded no digest', async () => {
    await index('SYN-1', 'a body', '2030-01-01');
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, 'retrieve', 'done', $2::jsonb, 'p', 'm', 0)`,
      [runId, JSON.stringify({ docIds: ['SYN-1'], embed_model_ver: 'e1' })],
    );
    const doc = (await readRunJournal(readers, runId))?.documents?.[0];
    expect(doc?.bodyUnchanged).toBeNull();
  });
});
