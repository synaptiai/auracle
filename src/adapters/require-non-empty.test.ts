// One validator, one argument order, one whitespace rule (issue #69).
//
// Each adapter used to carry a private `requireNonEmpty`, and the three had
// drifted into disagreeing about all three of those:
//
//   helpdesk.ts    (value, field)   TypeError, no trim, returns the value
//   freescout.ts   (field, value)   Error, trims, returns nothing
//   imap-smtp.ts   (field, value | null | undefined)
//
// Both parameters were `string`, so a line copied from one adapter into
// another compiled. The field name is never empty, so a swapped call always
// passed and an empty `idemKey` could reach the outbox. DEC-24 is the
// guarantee that key carries: the key comes from the action semantics, so two
// runs of one request produce the same key and land once on the target. A key
// that is empty carries nothing.
//
// The whitespace rule mattered on its own. A single space was rejected by two
// adapters and accepted by the third, so the same reply was valid or invalid
// depending on which target system it was bound for.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { FreeScoutEgressAdapter } from './freescout.js';
import { HelpdeskAdapter } from './helpdesk.js';
import { SmtpEgressAdapter } from './imap-smtp.js';
import { requireNonEmpty } from './types.js';


describe('requireNonEmpty', () => {
  it('rejects empty and whitespace-only values', () => {
    // The case the three copies disagreed on.
    for (const empty of ['', ' ', '   ', '\t', '\n', ' \t\n ']) {
      expect(() => requireNonEmpty('reply.idemKey', empty)).toThrow(
        /reply\.idemKey must not be empty/,
      );
    }
  });

  it('rejects null and undefined, which imap-smtp needed from its own copy', () => {
    for (const value of [undefined, null]) {
      expect(() => requireNonEmpty('reply.idemKey', value)).toThrow(/must not be empty/);
    }
  });

  it('still refuses a non-string at run time, for an untyped boundary', () => {
    // The signature rejects these at compile time, which is the point of
    // `value: string | null | undefined`. The runtime arm is the net for a
    // value that arrived as JSON and was never checked.
    for (const value of [42, {}, [], true]) {
      expect(() =>
        requireNonEmpty('reply.idemKey', value as unknown as string),
      ).toThrow(/must not be empty/);
    }
  });

  it('names the field it rejected, so the message says which one', () => {
    expect(() => requireNonEmpty('reply.disclosure', '')).toThrow(/reply\.disclosure/);
    expect(() => requireNonEmpty('draftExternalId', '')).toThrow(/draftExternalId/);
  });
});

/**
 * Every egress adapter, built with the least configuration that reaches the
 * validator.
 *
 * `requireNonEmpty` runs before any network call in each of these, so a
 * rejected field throws without a server, a mailbox or a database. The
 * configuration below is therefore never used; it exists to satisfy the
 * constructors.
 */
function egressAdapters(): { name: string; sendDraft: (id: string, key: string) => Promise<unknown> }[] {
  const freescout = new FreeScoutEgressAdapter({
    baseUrl: 'https://freescout.example.test',
    apiKey: 'synthetic-key',
    userId: 1,
    internalNote: false,
  });
  const smtp = new SmtpEgressAdapter({
    imap: {
      host: 'mail.example.test',
      port: 1,
      secure: false,
      user: 'agent@example.test',
      pass: 'synthetic-password',
    },
    smtp: { host: 'mail.example.test', port: 1, secure: false },
    fromAddress: 'agent@example.test',
    draftsMailbox: 'Drafts',
  });
  const helpdesk = new HelpdeskAdapter();
  return [
    { name: 'helpdesk', sendDraft: (id, key) => helpdesk.sendDraft(id, key) },
    { name: 'freescout', sendDraft: (id, key) => freescout.sendDraft(id, key) },
    { name: 'imap-smtp', sendDraft: (id, key) => smtp.sendDraft(id, key) },
  ];
}

/** The same three adapters, as objects, for the createDraft cases. */
function egressAdapterInstances(): {
  name: string;
  adapter: { createDraft: (reply: never) => Promise<unknown> };
}[] {
  const freescout = new FreeScoutEgressAdapter({
    baseUrl: 'https://freescout.example.test',
    apiKey: 'synthetic-key',
    userId: 1,
    internalNote: false,
  });
  const smtp = new SmtpEgressAdapter({
    imap: {
      host: 'mail.example.test',
      port: 1,
      secure: false,
      user: 'agent@example.test',
      pass: 'synthetic-password',
    },
    smtp: { host: 'mail.example.test', port: 1, secure: false },
    fromAddress: 'agent@example.test',
    draftsMailbox: 'Drafts',
  });
  return [
    { name: 'helpdesk', adapter: new HelpdeskAdapter() },
    { name: 'freescout', adapter: freescout },
    { name: 'imap-smtp', adapter: smtp },
  ];
}

/** A reply every adapter accepts, so a single bad field is the only variable. */
function reply(overrides: Record<string, unknown> = {}): never {
  return {
    ticketExternalId: '41',
    body: 'Your order ships tomorrow.',
    disclosure: 'This reply was drafted by an automated assistant.',
    provenance: {
      generatedBy: 'auracle',
      modelId: 'test/model-v1',
      promptVer: 'p-2026-01',
      generatedAt: '2026-01-02T03:04:05Z',
    },
    idemKey: 'refund:41:v1',
    ...overrides,
  } as never;
}

describe('every adapter validates the reply it is handed (DEC-24, DEC-14)', () => {
  // A guard over call *sites* cannot see a call that was deleted. Adversarial
  // review removed `requireNonEmpty('reply.idemKey', reply.idemKey)` from
  // HelpdeskAdapter.createDraft — the exact defect this file's header
  // describes — and every case here stayed green. These assert the behaviour
  // rather than the source, so a dropped call fails them.
  for (const { name, adapter } of egressAdapterInstances()) {
    for (const field of ['idemKey', 'body', 'disclosure', 'ticketExternalId'] as const) {
      it(`${name}.createDraft refuses a whitespace-only ${field}`, async () => {
        await expect(adapter.createDraft(reply({ [field]: '   ' }))).rejects.toThrow(
          new RegExp(`${field} must not be empty`),
        );
      });
    }
  }
});

describe('every adapter rejects a whitespace-only idemKey (DEC-24)', () => {
  for (const adapter of egressAdapters()) {
    it(`${adapter.name} refuses a single space`, async () => {
      await expect(adapter.sendDraft('draft-1', ' ')).rejects.toThrow(/idemKey must not be empty/);
    });

    it(`${adapter.name} refuses an empty key`, async () => {
      await expect(adapter.sendDraft('draft-1', '')).rejects.toThrow(/idemKey must not be empty/);
    });

    it(`${adapter.name} refuses an empty draft id`, async () => {
      await expect(adapter.sendDraft('   ', 'refund:41:v1')).rejects.toThrow(
        /draftExternalId must not be empty/,
      );
    });
  }
});

describe('the argument order cannot drift back', () => {
  /**
   * The compiler refuses the swap: `requireNonEmpty` takes a string literal
   * type in the field position, so a `string`-typed variable there resolves
   * to `never`. What the compiler cannot say is that the literal *names* the
   * value beside it — `requireNonEmpty('reply.body', reply.idemKey)` compiles
   * and is wrong, and the message it produces names the wrong field.
   *
   * Three things adversarial review broke in the first version of this guard,
   * all fixed by parsing instead of matching text:
   *
   *   - It read one directory and did not recurse, so a call in
   *     `src/adapters/vendor/` was unscanned. `requireNonEmpty` is exported,
   *     so a call anywhere in `src/` counts; the walk now covers all of it.
   *   - `([^)]+?)\)` truncated the value at the first `)`, so a correct call
   *     whose value was `keyFor(a, b)` was reported as a mismatch.
   *   - It compared only the last dot-segment, so `requireNonEmpty('reply.body',
   *     other.body)` passed. The whole expression is compared now.
   */
  const SRC = fileURLToPath(new URL('../', import.meta.url));

  /** Every `requireNonEmpty` call in a source file, as (field, value) text. */
  function callsIn(source: string): { field: string; value: string }[] {
    const tree = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ES2022, true);
    const found: { field: string; value: string }[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'requireNonEmpty'
      ) {
        const [field, value] = node.arguments;
        if (field !== undefined && value !== undefined && ts.isStringLiteralLike(field)) {
          found.push({ field: field.text, value: value.getText(tree).trim() });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return found;
  }

  function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        sourceFiles(full, found);
        continue;
      }
      if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(full);
    }
    return found;
  }

  const FILES = sourceFiles(SRC);
  const CALLS = FILES.flatMap((file) =>
    callsIn(readFileSync(file, 'utf8')).map((call) => ({
      ...call,
      file: relative(SRC, file).split(sep).join('/'),
    })),
  );

  it('scanned every source file under src/, so an empty list means something', () => {
    // The walk covers all of src/, not one directory: `requireNonEmpty` is
    // exported, so a call from src/relay/ or a nested src/adapters/vendor/
    // counts and must be scanned.
    const scanned = FILES.map((f) => relative(SRC, f).split(sep).join('/'));
    expect(scanned).toEqual(
      expect.arrayContaining([
        'adapters/helpdesk.ts',
        'adapters/freescout.ts',
        'adapters/imap-smtp.ts',
        'adapters/types.ts',
        'relay/relay.ts',
        'coordinator/coordinator.ts',
      ]),
    );
    expect(scanned.length).toBeGreaterThan(100);
    // 12 in helpdesk, 11 in freescout, 10 in imap-smtp when this was written.
    expect(CALLS.length).toBe(33);
  });

  it('still reads a call the text matcher could not', () => {
    // Without this the scan could pass because the parser walk broke.
    expect(callsIn("requireNonEmpty('a.b', a.b);")).toEqual([{ field: 'a.b', value: 'a.b' }]);
    // Multi-line, which an anchored pattern misses.
    expect(callsIn("requireNonEmpty(\n  'a.b',\n  a.b,\n);")).toEqual([
      { field: 'a.b', value: 'a.b' },
    ]);
    // A value containing parentheses, which truncation mangled.
    expect(callsIn("requireNonEmpty('k', keyFor(a, b));")).toEqual([
      { field: 'k', value: 'keyFor(a, b)' },
    ]);
  });

  it('names, in every call, the value it is checking', () => {
    // The rule is exact: the field literal is the value expression, verbatim.
    // That is what catches the mismatch the compiler cannot, including a
    // wrong object — `requireNonEmpty('reply.body', other.body)` — which a
    // comparison of the last dot-segment let through.
    //
    // It is strict on purpose, and it constrains the call site: a computed
    // value such as `keyFor(a, b)` cannot equal any field name. The remedy is
    // to name it first, which the thrown message then describes correctly:
    //
    //   const idemKey = keyFor(a, b);
    //   requireNonEmpty('idemKey', idemKey);
    //
    // All 33 call sites satisfy this today.
    const mismatched = CALLS.filter((call) => call.field !== call.value).map(
      (call) =>
        `${call.file}: requireNonEmpty('${call.field}', ${call.value}) `
        + `— the field must name the value verbatim; assign it to a const first`,
    );
    expect(mismatched).toEqual([]);
  });
});
