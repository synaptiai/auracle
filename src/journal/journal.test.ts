// Pure cases for the run-journal reader (src/journal/query.ts).
//
// Three things are provable without a database and are proved here: the
// canonical step order matches the coordinator's own set, the module issues
// nothing that could change a ledger, and the threshold recovery applies the
// policy engine's precedence to a journalled set the database does not
// constrain.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeThresholds } from '../policy/policy.js';
import { STEP_ORDER, agreementThresholdFromJournal, readGateThresholds } from './query.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/** Source with comments blanked, so prose about writing never trips a scan. */
function codeOf(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8').replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    '',
  );
}

describe('the canonical step order', () => {
  // The coordinator is the only writer of step ids, so its source is the
  // authority on the set. Read rather than restated: a step added there and
  // missed here would sort last as unrecognised, which is safe, but the
  // console would show the pipeline in the wrong shape for every run.
  const written = new Set(
    [...codeOf('src/coordinator/coordinator.ts').matchAll(/journal(?:Start|Finish)\('([a-z]+)'/g)]
      .map((match) => match[1]!),
  );

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
describe('the run-journal reader never writes', () => {
  it('issues no statement that could change the ledger', () => {
    const code = codeOf('src/journal/query.ts');
    for (const verb of [
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'GRANT',
      'MERGE', 'COPY', 'REFRESH', 'VACUUM', 'CALL',
    ]) {
      // Case-insensitive: SQL is not, and a lower-case statement would pass a
      // scan that only knew the shouted spelling.
      expect(code, `query.ts contains a ${verb} statement`).not.toMatch(
        new RegExp(`\\b${verb}\\b`, 'i'),
      );
    }
  });

  it('still reads, so the scan is not passing over an empty file', () => {
    expect(codeOf('src/journal/query.ts')).toMatch(/\bSELECT\b/);
  });

  // DEC-18. The journal holds a parked draft, an action payload and a fault
  // message that names two email addresses. None of them may be selected into
  // an operator surface. The scan covers the statements rather than the whole
  // file, because the reader tests for the presence of those keys by name and
  // that is the guard, not a leak.
  it('selects no draft text, no payload and no fault message', () => {
    const statements = codeOf('src/journal/query.ts').match(/`[^`]*SELECT[^`]*`/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      for (const column of ['payload', 'ticket_id', 'ticket_text', 'sender', 'message_id']) {
        expect(statement, `a statement reads ${column}`).not.toContain(column);
      }
      // Spelled apart from the loop: the draft column shares its name with a
      // substring of nothing else here, and a bare list entry reads as a typo.
      expect(statement).not.toMatch(/\bbody\b/);
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
  // `readRunJournal` already returns both gates in one object, so
  // `confidence(journal: RunJournal): number` takes one argument, mentions
  // neither gate in its signature, and passes. It also compiles, ships, and
  // puts a blended score on the console.
  //
  // What cannot be legitimate is an exported function that reads both
  // readings and answers with a number. `readRunJournal` touches both and is
  // not one, because it returns the journal; `agreementThresholdFromJournal`
  // returns a number and touches one. The pair is the rule.
  it('exports no function that reads both gates and returns a number', () => {
    const code = codeOf('src/journal/query.ts');
    const pattern = /export (?:async )?function (\w+)\([^)]*\)\s*:\s*([^{]+)\{/g;
    const checked: string[] = [];
    for (const match of code.matchAll(pattern)) {
      const [, name, returns] = match;
      // The body, by brace matching from the opening brace of the signature.
      // A regex to the next `}` stops at the first nested block and would
      // read a blend written below one as absent.
      let depth = 0;
      let end = match.index! + match[0].length - 1;
      for (let i = end; i < code.length; i += 1) {
        if (code[i] === '{') depth += 1;
        else if (code[i] === '}') {
          depth -= 1;
          if (depth === 0) { end = i; break; }
        }
      }
      const body = code.slice(match.index! + match[0].length, end);
      const answersNumber = /\bnumber\b/.test(returns!);
      // Coverage has more than one name now. The gate row carries a fraction
      // called `groundedness` and a verdict per claim beside it, so a blend
      // can reach coverage by counting the supported claims and never write
      // the word. Every name for the same reading counts as reading it.
      const readsCoverage = /\bgroundedness\b|\bclaimVerdicts\b|\bsupported\b|\bcoverage\b/
        .test(body);
      const readsBoth = /\bagreement\b/.test(body) && readsCoverage;
      checked.push(name!);
      expect(answersNumber && readsBoth, `${name!} blends the two gates`).toBe(false);
    }
    // Not vacuous: the scan found the exported functions it is meant to read.
    expect(checked).toContain('readRunJournal');
    expect(checked).toContain('agreementThresholdFromJournal');
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
