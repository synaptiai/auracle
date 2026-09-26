// Pure cases for the run-journal reader (src/journal/query.ts).
//
// Three things are provable without a database and are proved here: the
// canonical step order matches the coordinator's own set, the module issues
// nothing that could change a ledger, and the threshold recovery applies the
// policy engine's precedence to a journalled set the database does not
// constrain.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeThresholds } from '../policy/policy.js';
import { STEP_ORDER, agreementThresholdFromJournal, readGateThresholds } from './query.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/**
 * Source with prose blanked, so writing about writing never trips a scan.
 *
 * Three kinds of prose, and each one tripped a scan before it was blanked.
 * JavaScript comments are the obvious kind. SQL comments are not: they live
 * inside a template literal, so stripping JavaScript comments leaves them,
 * and a note explaining why a statement digests a body rather than returning
 * it reads to a scanner as a statement returning a body.
 *
 * Import lines are the third. A module path is not a statement, and
 * `../ledger/insert.js` reads as an INSERT to a scan that looks for the word.
 */
function codeOf(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8')
    .replace(/^import[^;]*;$/gm, '')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    .replace(/^\s*--[^\n]*$/gm, '');
}

describe('the canonical step order', () => {
  // The coordinator is the only writer of step ids, so its source is the
  // authority on the set. Read rather than restated: a step added there and
  // missed here would sort last as unrecognised, which is safe, but the
  // console would show the pipeline in the wrong shape for every run.
  //
  // One module per step since issue #75, so the scan reads the directory.
  // The escalate row is written by the sequencer's own helper in
  // `steps/context.ts`, and that file is in the walk too.
  const written = new Set(
    readdirSync(join(REPO_ROOT, 'src/coordinator/steps'))
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
      .flatMap((name) => [
        ...codeOf(join('src/coordinator/steps', name))
          .matchAll(/journal(?:Start|Finish)\(ctx, '([a-z]+)'/g),
      ])
      .map((match) => match[1]!),
  );

  it('found the writers, so the comparison below means something', () => {
    // Without this the set could match an empty STEP_ORDER because the scan
    // broke rather than because the two agree.
    expect(written.size).toBeGreaterThanOrEqual(7);
  });

  it('holds exactly the step ids the coordinator journals', () => {
    expect([...written].sort()).toEqual([...STEP_ORDER].sort());
  });

  it('is not the alphabetical order a bare ORDER BY would give', () => {
    // The point of the constant. If the two ever coincide, the module is
    // supplying nothing the database could not, and the doc comment claiming
    // otherwise has become false.
    expect(STEP_ORDER).not.toEqual([...STEP_ORDER].sort());
  });

  it('puts each step after the one that must precede it', () => {
    const at = (step: string): number => STEP_ORDER.indexOf(step);
    expect(at('classify')).toBeLessThan(at('retrieve'));
    expect(at('retrieve')).toBeLessThan(at('compose'));
    expect(at('compose')).toBeLessThan(at('gate'));
    // Park and execute are the two arms of the gate decision; escalate is
    // always where the run stopped.
    expect(at('gate')).toBeLessThan(at('park'));
    expect(at('gate')).toBeLessThan(at('execute'));
    expect(at('escalate')).toBe(STEP_ORDER.length - 1);
  });
});

// The console reads this module against whatever database it is pointed at,
// and the module's own header promises that cannot damage one. A statement
// added later would break that promise and nothing else here would notice.
describe('the read modules never write', () => {
  // Each module's header promises a console can point it at any database
  // without damaging one. A statement added later would break that promise
  // and nothing else here would notice.
  const readers = [
    'src/journal/query.ts',
    'src/conversation/query.ts',
    'src/documents/query.ts',
  ];

  // Every statement these modules issue is a literal that starts with SELECT.
  //
  // A verb list was tried and defeated three ways, each of which compiled and
  // shipped: `SELECT setval('schema_version_seq', 1)` writes through a
  // function and names no forbidden verb; `DO $$ BEGIN EXECUTE 'trunc' ||
  // 'ate table run'; END $$` names neither `DO` nor `EXECUTE` in the list and
  // builds the verb at runtime; and `const verb = 'DEL' + 'ETE'` defeats any
  // list by never spelling the word. A scan over identifiers cannot close
  // that, because the thing being tested is what the database is asked to do
  // rather than which words appear.
  //
  // So this reads the call sites instead. Each `query(` in these modules must
  // take a literal or a module constant, and every such constant must begin
  // with SELECT. A dynamic string cannot be checked here and is refused
  // outright, which is the only honest answer a static scan can give it.
  it.each(readers)('%s asks the database only for SELECT statements', (reader) => {
    const code = codeOf(reader);
    const calls = [...code.matchAll(/\.query[<(]/g)];
    expect(calls.length, `${reader} issues no statement at all`).toBeGreaterThan(0);

    // The whole first argument, not the text up to the first comma.
    //
    // A comma-terminated match read `SELECT t.conversation_id` out of a
    // multi-column literal and checked that fragment alone — so appending
    // `; SELECT setval(...)` to the end of such a statement passed every rule
    // below, including the two the guard names in its own comment. A literal
    // is read to its closing quote and a constant to its identifier.
    for (const call of code.matchAll(/\.query(?:<[^>]*>)?\(\s*(`[^`]*`|'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)/g)) {
      const argument = call[1]!.trim();
      const literal = /^(['"`])([\s\S]*)$/.exec(argument);
      if (literal !== null) {
        const statement = literal[2]!;
        expect(statement.trimStart().toUpperCase(), `${reader} issues a non-SELECT literal`)
          .toMatch(/^SELECT\b/);
        // Beginning with SELECT is not the same as reading. A statement can
        // write through a function — `SELECT setval(...)` advances a sequence
        // and passes every check that looks at the leading verb — and a
        // semicolon lets a second statement ride behind the first.
        expect(statement, `${reader} writes through a function`).not.toMatch(
          /\b(?:setval|nextval|dblink|lo_import|lo_export|pg_write|pg_advisory)\w*\s*\(/i,
        );
        expect(statement.replace(/;\s*$/, ''), `${reader} chains a second statement`)
          .not.toContain(';');
        continue;
      }
      // A named constant: it must be one this module defines as a SELECT.
      expect(argument, `${reader} builds a statement rather than naming one`)
        .toMatch(/^[A-Z][A-Z0-9_]*$/);
      const defined = new RegExp(`const ${argument} = \`\\s*SELECT\\b`).test(code)
        || new RegExp(`const ${argument} = \`[\\s\\S]{0,40}?SELECT\\b`).test(code);
      expect(defined, `${reader}'s ${argument} is not a SELECT this module defines`).toBe(true);
    }
  });

  // DEC-18. The journal holds a parked draft, an action payload and a fault
  // message that names two email addresses. None of them may be selected into
  // an operator surface. The scan covers the statements rather than the whole
  // file, because the reader tests for the presence of those keys by name and
  // that is the guard, not a leak.
  // The drafted reply is returned now, and DEC-40 is why: a console may
  // approve a parked draft, and an approver who cannot read the reply cannot
  // approve it. It comes out of the `step_journal.result` object this module
  // already selects, so no statement names it.
  //
  // Scoped to this module on purpose, and not over `readers`. The
  // conversation reader selects `turn.body_text` and returns it, which is its
  // whole job: issue #48 decided the console shows the customer's message and
  // the runbook states the posture that follows. A shared list would have to
  // carry an exemption for the one module the rule was never about, which
  // reads as a rule with a hole rather than two rules.
  //
  // What this cannot check: everything the module returns from a park or a
  // compose row travels inside the `step_journal.result` object, which the
  // statement selects wholesale. So a field added to a returned record — a
  // fault message, an action payload — is invisible here, and the case below
  // covers that instead. This one is about the columns a statement reaches.
  it('reaches no column of customer text directly', () => {
    const statements = codeOf('src/journal/query.ts').match(/`[^`]*SELECT[^`]*`/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      for (const column of ['payload', 'ticket_id', 'ticket_text', 'sender', 'message_id']) {
        expect(statement, `a statement reads ${column}`).not.toContain(column);
      }
      // `document.body` may be read, and only to digest it. The digest
      // answers whether a document changed since the run read it; the text
      // itself would put the corpus on the wire to answer that, and the
      // console has its own reader for a document a person opens.
      const bodies = [...statement.matchAll(/\bbody\b/g)];
      for (const hit of bodies) {
        const around = statement.slice(Math.max(0, hit.index! - 24), hit.index! + 12);
        expect(around, 'a statement returns a body rather than digesting it')
          .toMatch(/sha256\(/);
      }
    }
  });

  // The two fields the module withholds, checked where they actually travel.
  //
  // Both ride inside `step_journal.result`, which the statement selects
  // wholesale — so the statement scan above cannot see them, and adding
  // `faultText: stringAt(result, 'error')` to the returned record passed it.
  // The park record's shape is the thing to pin: it reports that a fault and
  // a payload were recorded, and carries neither.
  it('returns the fault message and the action payload as presence alone', () => {
    const code = codeOf('src/journal/query.ts');
    const record = /function toParkRecord\([\s\S]*?\n}/.exec(code)?.[0];
    expect(record, 'toParkRecord was not found, so this scan checked nothing').toBeDefined();
    // Reads the keys, and only to ask whether they are there.
    for (const key of ['error', 'payload']) {
      for (const hit of record!.matchAll(new RegExp(`'${key}'`, 'g'))) {
        const around = record!.slice(Math.max(0, hit.index! - 40), hit.index!);
        expect(around, `the ${key} key is read for its value rather than its presence`)
          .toMatch(/\bhas\(/);
      }
    }
  });

  // DEC-05. The two gates are independent, and the absence of a combining
  // function is the rule. A helper taking both and returning one number would
  // compile, ship, and put a blended confidence on the console.
  it('exports nothing that reads both gates', () => {
    const code = codeOf('src/journal/query.ts');
    for (const [, name, params] of code.matchAll(/export (?:async )?function (\w+)\(([^)]*)\)/g)) {
      const takesBoth = /agreement/i.test(params!) && /groundedness/i.test(params!);
      expect(takesBoth, `${name!} reads both gates`).toBe(false);
    }
  });

  // The case above reads parameters, and a blender does not need two of them.
  // `readRunJournal` returns both gates in one object, so a blender takes one
  // argument and mentions neither gate in its signature.
  //
  // Parsing declarations was tried twice and defeated twice. A regex over
  // `export function NAME(...): TYPE {` misses an arrow constant, and
  // `([^{]+)\{` captures nothing useful when the return type is itself an
  // object — so both of these compiled, shipped, and passed:
  //
  //   export const confidence = (j: RunJournal): number => …
  //   export function confidence(j: RunJournal): { score: number } { … }
  //
  // So this does not parse. It splits the module at each `export` and asks
  // one question of the text that follows: does it read both gates. Anything
  // that does must be named here, which makes adding one a deliberate act
  // rather than a shape the scan has not met yet.
  //
  // `readRunJournal` is the one legitimate reader: it returns the journal,
  // which is both gates side by side and no number combining them. That is
  // exactly what DEC-05 permits and what a blender is not.
  it('exports nothing that reads both gates, beyond the reader that returns them', () => {
    const code = codeOf('src/journal/query.ts');
    const permitted = new Set(['readRunJournal']);
    const chunks = code.split(/\bexport\s+/).slice(1);
    expect(chunks.length).toBeGreaterThan(3);

    const named: string[] = [];
    for (const chunk of chunks) {
      const declared = /^(?:async\s+)?(function|const|interface|type|class)\s+(\w+)/.exec(chunk);
      if (declared === null) continue;
      const [, kind, name] = declared as unknown as [string, string, string];
      named.push(name);
      // A type is not a blender. `RunJournal` declares both gates because
      // that is the shape the reader returns, side by side and uncombined —
      // which is what DEC-05 permits. Only code can average them.
      if (kind === 'interface' || kind === 'type') continue;
      // Every spelling of coverage. The gate row carries a fraction called
      // `groundedness` and a verdict per claim beside it, so a blend can
      // reach coverage by counting supported claims and never write the word.
      const readsCoverage =
        /\bgroundedness\b|\bclaimVerdicts\b|\bsupported\b|\bcoverage\b/.test(chunk);
      const readsBoth = /\bagreement\b/.test(chunk) && readsCoverage;
      if (!readsBoth) continue;
      expect(permitted.has(name), `${name} reads both gates and is not permitted to`).toBe(true);
    }

    // Not vacuous: the split found the module's exports, and the permitted
    // one is among them.
    expect(named).toContain('readRunJournal');
    expect(named).toContain('agreementThresholdFromJournal');
  });
});

describe('the agreement threshold a run was judged against', () => {
  const thresholds = makeThresholds({
    agreement: 0.7,
    groundednessBlock: 0.7,
    groundednessReview: 0.8,
    perIntent: { refund_request: 0.9 },
  });

  it('takes the fitted value when the intent has one (DEC-41)', () => {
    expect(agreementThresholdFromJournal('refund_request', thresholds)).toBe(0.9);
  });

  it('falls back to the global value for an intent with no entry', () => {
    expect(agreementThresholdFromJournal('password_reset', thresholds)).toBe(0.7);
  });

  it('normalises the intent id through the engine, not here', () => {
    // The classifier returns a normalised id and the map is keyed on one.
    // Passing the raw id through proves this module re-encodes no part of
    // that rule: the engine lower-cases and trims it.
    expect(agreementThresholdFromJournal('  Refund_Request ', thresholds)).toBe(0.9);
  });

  it('reports an absence when the run recorded no intent', () => {
    expect(agreementThresholdFromJournal(null, thresholds)).toBeNull();
  });

  it('reports an absence when the gate journalled no thresholds', () => {
    expect(agreementThresholdFromJournal('refund_request', null)).toBeNull();
  });
});

describe('the journalled threshold set', () => {
  const sound = { agreement: 0.7, groundednessBlock: 0.7, groundednessReview: 0.8 };

  it('is accepted when every fraction is one', () => {
    expect(readGateThresholds(sound)).toEqual(sound);
  });

  it('keeps the fitted map when the journal carried one', () => {
    const withMap = { ...sound, perIntent: { refund_request: 0.9 } };
    expect(readGateThresholds(withMap)?.perIntent).toEqual({ refund_request: 0.9 });
  });

  // The engine's fallback arm returns `thresholds.agreement` unchecked,
  // because every set it is handed was built by `makeThresholds`. This one
  // comes out of jsonb, which enforces no shape at all. Without the guard a
  // string or a missing key would reach the console as a number, and it would
  // display a threshold no run was ever compared against.
  it.each([
    ['a value that is not an object', 0.7],
    ['a null', null],
    ['an array', [0.7]],
    ['a set missing the agreement value', { groundednessBlock: 0.7, groundednessReview: 0.8 }],
    ['a threshold recorded as a string', { ...sound, agreement: '0.7' }],
    ['a threshold above one', { ...sound, agreement: 1.4 }],
    ['a threshold at zero', { ...sound, agreement: 0 }],
    ['a threshold that is not finite', { ...sound, groundednessReview: Number.NaN }],
  ])('refuses %s', (_case, raw) => {
    expect(readGateThresholds(raw)).toBeNull();
  });

  it('drops a fitted map that is not an object rather than the whole set', () => {
    // The set is still the pair the gate compared against, and DEC-41's map
    // is optional. Refusing the set over an unreadable map would report the
    // coverage thresholds as unrecorded when the journal holds them.
    const result = readGateThresholds({ ...sound, perIntent: 'unrecoverable' });
    expect(result).toEqual(sound);
  });
});
