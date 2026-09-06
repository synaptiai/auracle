// The control-band evaluator, and the definitions it is pinned to
// (docs/v1-architecture.md sections 4.10 and 5, bands.yaml).
//
// Pure cases only. The ledger half lives in `bands.db.test.ts`.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LOOKBACK_DAYS, METRICS, WINDOW_DAYS } from './metrics.js';
import { evaluateMetric } from './evaluate.js';
import type { DailySample } from './evaluate.js';
import { validateBandsArtifact, writeBandsArtifact } from './artifact.js';
import { bandLine, humanValue, lastCompleteDay, parseDay } from './run.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A run of days each holding the same value, ending the day before `day`. */
function priorDays(values: readonly (number | null)[]): DailySample[] {
  return values.map((value, i) => ({
    // 2026-01-01 onward, one per day. The evaluator orders by this string.
    day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    value,
    count: value === null ? 0 : 10,
    notReached: 0,
    // One provider throughout, so these cases test the band and not the
    // provider guard. src/bands/provider.test.ts tests the guard.
    provider: 'stub',
    unrecorded: 0,
    pending: 0,
  }));
}

/**
 * Words that name the number this file must not hold, not one spelling of it.
 *
 * `mean` is singular here on purpose. `means` is a verb far more often than a
 * plural, so "the file defines the window, which means the band covers 30
 * days" would fail this guard while stating the truth. A claim written as
 * "the means and the sigmas" evades it, and `sigma` catches that pairing.
 */
const BASELINE = /\bbaselines?\b|\bsigmas?\b|\bmean\b|\bcent(?:re|er)s?\b/i;

/**
 * A denial, read over one clause and never over a whole sentence.
 *
 * Read over the sentence, one incidental `not` anywhere in it exempted every
 * claim beside it: "the four baselines in `bands.yaml` are 0.31 and 0.74, not
 * estimates" passed.
 */
const DENIES = /\b(?:no|not|never|nothing|neither|without|cannot)\b/i;

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function clausesOf(sentence: string): string[] {
  return sentence.split(/[,;:]|\s+\b(?:and|but|while|whereas)\b\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

describe('the definitions the report is pinned to', () => {
  // bands.yaml is the only YAML this application would read, and no parser is
  // in the dependency tree. The definitions are restated here and pinned
  // against the file instead, exactly as src/latency/query.ts restates the
  // ledger's terminal states. A changed window then fails this case rather
  // than silently changing a control band under an operator.
  const yaml = readFileSync(join(REPO_ROOT, 'bands.yaml'), 'utf8');

  // Two-space indented keys under `metrics:` are the metric names, and each
  // metric's body runs to the next line indented two spaces or less. Hoisted,
  // because four cases below read the same parse.
  //
  // Reading the body as a contiguous run of four-space lines ended it at the
  // first blank line. A baseline re-declared after one was then invisible to
  // every case below, and the file passed carrying the field it must not
  // hold. Whatever follows the name's colon is body too, so a mapping written
  // on the name line is read like an indented key rather than skipped.
  const block = yaml.slice(yaml.indexOf('\nmetrics:'));
  const bodies = new Map<string, string>();
  {
    let name: string | null = null;
    let held: string[] = [];
    const close = (): void => {
      if (name !== null) bodies.set(name, held.join('\n'));
      name = null;
      held = [];
    };
    for (const line of block.split('\n')) {
      const named = /^ {2}([^\s:#][^:]*):/.exec(line);
      if (named) {
        close();
        name = named[1]!.trim().replace(/^['"]|['"]$/g, '');
        const trailing = line.slice(line.indexOf(':') + 1).trim();
        if (trailing !== '') held.push(`    ${trailing}`);
      } else if (name !== null && (line.trim() === '' || /^ {3,}\S/.test(line))) {
        held.push(line);
      } else {
        close();
      }
    }
    close();
  }

  it('names the same window and sample interval bands.yaml does', () => {
    const found = /^window_days:\s*(\d+)/m.exec(yaml);
    expect(found, 'bands.yaml no longer declares window_days').not.toBeNull();
    expect(WINDOW_DAYS).toBe(Number(found![1]));
    // Pinned as a literal, because no constant restates it. The job reports
    // one UTC day per run, so a file asking for an hourly sample would
    // describe a cadence nothing here can produce.
    expect(yaml, 'bands.yaml no longer samples daily').toMatch(/^sample_interval: daily$/m);
  });

  it('names the same four metrics bands.yaml does', () => {
    const names = [...block.matchAll(/^ {2}([a-z_]+):$/gm)].map((m) => m[1]!);
    expect(names.length, 'bands.yaml declares no metrics').toBeGreaterThan(0);
    expect(METRICS.map((m) => m.name).slice().sort()).toEqual(names.slice().sort());
  });

  it('declares no key beyond a source and a direction, so no baseline returns', () => {
    // A whitelist, and not a search for the field that was removed. A search
    // finds `baseline_mean` and misses `"baseline_mean"`, `mean`, `baseline:
    // {mean: 0.3}` and `baseline_mean :`. Every one of those re-declares the
    // value this file must not hold, and an adversarial pass got all four
    // past the first version of this case.
    //
    // The file carried a null baseline for each metric once. Nothing parsed
    // them, and they could never have been filled: a baseline is a
    // production number, and this repository ships synthetic fixtures only
    // (DEC-18).
    const allowed = new Set(['source', 'direction']);
    for (const metric of METRICS) {
      const body = bodies.get(metric.name);
      expect(body, `bands.yaml lost ${metric.name}`).toBeDefined();
      const declared: string[] = [];
      for (const line of body!.split('\n')) {
        if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
        // Every line of a body is one key and one plain value. A key alone
        // says nothing about its value, and `source: {from: composer, mean:
        // 0.31}` declares only the key `source` while carrying the numbers
        // this file must not hold. A block scalar hides them the same way.
        const pair = /^ {4}([^\s:#][^:]*): {0,40}([^\s#].*)?$/.exec(line);
        expect(pair, `${metric.name} carries a line this file cannot hold: ${line}`)
          .not.toBeNull();
        declared.push(pair![1]!.trim().replace(/^['"]|['"]$/g, ''));
        const value = (pair![2] ?? '').trim();
        expect(value, `${metric.name} declares ${pair![1]} with no value`).not.toBe('');
        expect(value[0], `${metric.name} gives ${pair![1]} a value that can carry a map`)
          .not.toMatch(/[[{>|&*!]/);
      }
      expect(new Set(declared), `${metric.name} declares a key this file must not hold`)
        .toEqual(allowed);
    }
    // Nothing above the metrics either. `window_days` and `sample_interval`
    // are the only top-level keys beside the metrics, and a case above pins
    // each of their values.
    //
    // Every key, not the lowercase ones. Under `[a-z_]+` a key the pattern
    // could not read was simply absent from the found set, so the equality
    // still held: `baselines_v1:` and `Baselines:` both restored a full set
    // of numbers with every case green.
    const top = [...yaml.matchAll(/^([^\s:#][^:]*):/gm)]
      .map((m) => m[1]!.trim().replace(/^['"]|['"]$/g, ''));
    expect(new Set(top), 'bands.yaml declares a top-level key beyond the three it needs')
      .toEqual(new Set(['window_days', 'sample_interval', 'metrics']));
  });

  it('gives every metric a source with a value, not a comment', () => {
    // Anchored. `toContain('source:')` was satisfied by a trailing comment
    // reading `# source: outbox delivery status`, so a metric could lose its
    // origin and still pass while declaring which way is bad and never of
    // what.
    for (const metric of METRICS) {
      const body = bodies.get(metric.name);
      expect(body!, `bands.yaml lost the source of ${metric.name}`)
        .toMatch(/^ {4}source: {0,40}\S/m);
      expect(body!, `bands.yaml lost the direction of ${metric.name}`)
        .toMatch(new RegExp(`^ {4}direction: {0,40}${metric.direction}\\b`, 'm'));
    }
  });

  // Scoped to the header, and the scope is asserted. `indexOf` returns -1 for
  // a renamed key, and `slice(0, -1)` is the whole file again — the very
  // widening this case was narrowed to close.
  const headerSentences = ((): string[] => {
    const at = yaml.indexOf('window_days:');
    expect(at, 'bands.yaml no longer declares window_days').toBeGreaterThan(-1);
    return sentencesOf(
      yaml.slice(0, at).split('\n').map((line) => line.replace(/^#\s?/, '')).join(' '),
    );
  })();

  it('says where the baseline does come from, in its own header', () => {
    // Both words in one sentence. A match for `ledger` anywhere in the file
    // passed while the explanation was deleted, because an unrelated line
    // mentioning the ledger survived.
    const said = headerSentences.some((s) => /baseline/i.test(s) && /ledger/i.test(s));
    expect(said, 'bands.yaml no longer says the baseline comes from the ledger').toBe(true);
  });

  it('never says in that header that a baseline is shipped here', () => {
    // The case above is satisfied by a false sentence as easily as a true
    // one: "the baseline below was measured on our reference ledger" names
    // both words. A shipped baseline is an adopter's production number in a
    // tracked file, which DEC-18 refuses.
    const settled = /\b(?:shipped|ships|measured|set|hard-?coded|carries|holds|stored|declares)\b/i;
    const claims = headerSentences.flatMap(clausesOf).filter(
      (clause) => BASELINE.test(clause) && settled.test(clause) && !DENIES.test(clause),
    );
    expect(claims, 'bands.yaml says a baseline is settled here').toEqual([]);
  });
});

// What these cases can decide, and what they cannot.
//
// They decide that no shipped document writes the file name and a baseline
// into one sentence without denying one. That is a wording test, so it cannot
// decide that a document is truthful, and two evasions are known and open:
//
//   - A claim split across two sentences. "The centres are stored in
//     `bands.yaml`. Each mean is fixed there." Neither sentence carries both.
//   - A claim that names no file at all.
//
// Widening the unit to the paragraph closes the first and fails on true
// prose, because a paragraph naming the file also describes what the command
// computes. The structural cases above are the half that does not depend on
// wording: a whitelist holds against spellings nobody has enumerated.
describe('the documents that cite bands.yaml', () => {
  // Discovered, not listed. A hardcoded pair could never catch a third
  // document carrying the same claim, and one did: the epic handoff.
  //
  // The root documents are in scope too. `README.md` states the published
  // numbers and `AGENTS.md` names the command, and a false claim in either
  // reaches more readers than one under `docs/`.
  //
  // Standing documents only. `intent/` and `.decisions/` record the state
  // that motivated a change, so a sentence there describing the file as it
  // stood before that change is the record and not a defect.
  const SHIPPED = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md'];
  const cites = [
    ...readdirSync(join(REPO_ROOT, 'docs'), { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.md'))
      .map((name) => join('docs', name)),
    ...SHIPPED,
  ]
    .filter((path) => readFileSync(join(REPO_ROOT, path), 'utf8').includes('bands.yaml'))
    .sort();

  it('finds the documents that carry the claim', () => {
    // Named, not counted. A count of five was reached by two scaffold prompts
    // that make no baseline claim, so it stayed green while both documents
    // this case exists to cover fell out of the glob.
    for (const path of ['docs/operations.md', 'docs/internal/epic-v2-handoff.md']) {
      expect(cites, `${path} no longer reaches this case`).toContain(path);
    }
  });

  it.each(cites)('%s never says the file holds a baseline', (path) => {
    // A claim, not a sentence. The first version matched one wording, and an
    // adversarial pass evaded it five ways: an extra noun, a possessive, `not
    // set` for `null`, an unbackticked file name, and a sentence split.
    //
    // The denial is read over the clause that carries the number, and the
    // number is read under every word that names it. Read over the whole
    // sentence, "the four baselines in `bands.yaml` are 0.31 and 0.74, not
    // estimates" passed; read as `baseline` alone, "`bands.yaml` records the
    // mean and the sigma for each metric" passed.
    const claims = readFileSync(join(REPO_ROOT, path), 'utf8')
      .split(/\n\s*\n/)
      .flatMap((block) => sentencesOf(block))
      .filter((sentence) => /bands\.yaml/.test(sentence))
      .flatMap(clausesOf)
      .filter((clause) => BASELINE.test(clause) && !DENIES.test(clause));
    expect(claims, `${path} says bands.yaml holds a baseline`).toEqual([]);
  });
});

describe('the baseline', () => {
  // The headline invariant, and it was pinned by nothing.
  //
  // A first version supplied January days and judged a February one, so no
  // prior sample could equal the day under test and relaxing the filter from
  // `<` to `<=` changed no result. The window here therefore CONTAINS an
  // entry for the day under test, carrying a value far from the rest: the
  // only way it stays out of the mean is if the filter excludes it by day.
  it('is built from days before the one under test, never including it', () => {
    const target = '2026-02-01';
    const prior = priorDays(Array.from({ length: WINDOW_DAYS }, () => 0.1));
    // 31 samples supplied, one of them the target's own, so the cut cannot
    // drop it for being outside the window either.
    prior.push({ day: target, value: 100, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' });

    const evaluated = evaluateMetric(
      METRICS[0]!,
      { day: target, value: 0.9, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' },
      prior,
    );
    // Admitting the target would put 100 in the mean and move it to ~3.3.
    expect(evaluated.baseline?.mean).toBeCloseTo(0.1, 12);
    expect(evaluated.baseline?.days).toBe(WINDOW_DAYS);
  });

  it('reports no band and names the shortfall when the history is thin', () => {
    const prior = priorDays(Array.from({ length: WINDOW_DAYS - 1 }, () => 0.1));
    const evaluated = evaluateMetric(METRICS[0]!, { day: '2026-02-01', value: 0.5, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' }, prior);
    expect(evaluated.band).toBeNull();
    expect(evaluated.shortfall).toBe(`no baseline: ${WINDOW_DAYS - 1} of ${WINDOW_DAYS} days`);
  });

  // No spread means no sigma scale, so no band. A distance over a zero sigma
  // is infinity, and the three-sigma action is a pull request.
  it('reports no band when a flat window moved today, and says it moved', () => {
    const prior = priorDays(Array.from({ length: WINDOW_DAYS }, () => 0.4));
    const evaluated = evaluateMetric(METRICS[0]!, { day: '2026-02-01', value: 0.9, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' }, prior);
    expect(evaluated.band).toBeNull();
    expect(evaluated.shortfall).toBe(`no spread over ${WINDOW_DAYS} days, and today moved to 0.9`);
  });

  // The other flat window, and the common one. A count whose healthy value is
  // zero has no spread on any working system, so calling that a fault every
  // day would train an operator to ignore the line.
  it('reports a flat window that did not move as steady, not as a fault', () => {
    const prior = priorDays(Array.from({ length: WINDOW_DAYS }, () => 0));
    const evaluated = evaluateMetric(
      METRICS[3]!,
      { day: '2026-02-01', value: 0, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' },
      prior,
    );
    expect(METRICS[3]!.name).toBe('relay_delivery_unknown_count');
    expect(evaluated.band).toBeNull();
    expect(evaluated.shortfall).toBe(`steady at 0 over ${WINDOW_DAYS} days`);
  });

  it('refuses a baseline when a day inside the window measured nothing', () => {
    // A null day is not a zero. Averaging over it would invent a number for
    // the day the system knows least about.
    const values: (number | null)[] = Array.from({ length: WINDOW_DAYS }, () => 0.1);
    values[5] = null;
    const evaluated = evaluateMetric(METRICS[0]!, { day: '2026-02-01', value: 0.5, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' }, priorDays(values));
    expect(evaluated.band).toBeNull();
    expect(evaluated.shortfall).toBe(`no baseline: ${WINDOW_DAYS - 1} of ${WINDOW_DAYS} days`);
  });

  // Unmeasured days are dropped BEFORE the window is cut, not after.
  //
  // Cutting first took the last 30 calendar days and then discarded the quiet
  // ones, so a single day with no runs left 29 and no band could form for the
  // next 30 reports. The count is deliberately 45 rather than LOOKBACK_DAYS:
  // a fixture sized by the constant shrinks with it, and this case has to keep
  // its gaps when that constant changes.
  it('drops quiet days before it cuts the window, not after', () => {
    const values: (number | null)[] = Array.from({ length: 45 }, (_, i) => (i % 2 === 0 ? 0 : 0.2));
    // Ten quiet days scattered through the most recent stretch.
    for (const i of [44, 42, 40, 38, 36, 34, 32, 30, 28, 26]) values[i] = null;
    const evaluated = evaluateMetric(
      METRICS[0]!,
      { day: '2026-09-01', value: 0.9, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' },
      priorDays(values),
    );
    expect(evaluated.baseline?.days).toBe(WINDOW_DAYS);
    expect(evaluated.shortfall).toBeNull();
  });

  it('still reports a shortfall when the days supplied cannot fill a window', () => {
    const values: (number | null)[] = Array.from({ length: 45 }, () => null);
    for (let i = 0; i < 12; i += 1) values[i] = i % 2 === 0 ? 0 : 0.2;
    const evaluated = evaluateMetric(
      METRICS[0]!,
      { day: '2026-09-01', value: 0.9, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' },
      priorDays(values),
    );
    expect(evaluated.band).toBeNull();
    expect(evaluated.shortfall).toBe(`no baseline: 12 of ${WINDOW_DAYS} days`);
  });

  // The reach itself is a property of the job, not of this function: the
  // evaluator judges whatever days it is handed. `bands.db.test.ts` pins that
  // the job hands it days from further back than one window.
  it('is configured to read more calendar days than a window holds', () => {
    expect(LOOKBACK_DAYS).toBeGreaterThan(WINDOW_DAYS);
  });

  it('takes the last full window when more days are supplied', () => {
    const prior = priorDays(Array.from({ length: WINDOW_DAYS + 10 }, (_, i) => (i < 10 ? 9 : 0.1)));
    const evaluated = evaluateMetric(METRICS[0]!, { day: '2026-03-01', value: 0.1, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' }, prior);
    // The ten outlying days fall outside the trailing window and must not
    // reach the mean.
    expect(evaluated.baseline?.mean).toBeCloseTo(0.1, 12);
  });
});

describe('the band verdict', () => {
  // Sigma over 30 days that are 0.1 twenty-nine times and 0.2 once is small,
  // so build a spread by hand instead: alternating values give a known sigma.
  const spread = priorDays(Array.from({ length: WINDOW_DAYS }, (_, i) => (i % 2 === 0 ? 0.0 : 0.2)));
  // mean 0.1, population sigma 0.1.

  // The three lines are bands.yaml's contract and the last one costs a pull
  // request, so each is pinned from both sides. Mid-band values alone let a
  // threshold move by a quarter of a sigma with every case still green.
  //
  // mean 0.1, sigma 0.1, so value = 0.1 + z/10.
  it('names which of the three defined actions applies', () => {
    const at = (value: number): string | null =>
      evaluateMetric(METRICS[0]!, { day: '2026-02-01', value, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' }, spread).band?.action ?? null;
    // Straddled within a fiftieth of a sigma. The exact boundary is not
    // asserted, because (0.2 - 0.1) / 0.1 lands either side of 1 depending on
    // float rounding and the case would pin the rounding rather than the
    // rule. This margin still fails any threshold moved by more than 0.02.
    expect(at(0.15)).toBe('in_band');           // 0.5 sigma
    expect(at(0.1998)).toBe('in_band');         // 0.998
    expect(at(0.2002)).toBe('log');             // 1.002
    expect(at(0.2998)).toBe('log');             // 1.998
    expect(at(0.3002)).toBe('diagnose');        // 2.002
    expect(at(0.3998)).toBe('diagnose');        // 2.998
    expect(at(0.4002)).toBe('propose_change');  // 3.002
    expect(at(0.45)).toBe('propose_change');    // 3.5 sigma
  });

  it('measures the distance in sigmas, signed, so the side is readable', () => {
    const below = evaluateMetric(METRICS[0]!, { day: '2026-02-01', value: -0.2, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' }, spread);
    expect(below.band?.sigmaDistance).toBeCloseTo(-3, 10);
  });

  // AGENTS.md: "At zero, agreement is always 1.0 and the gate passes every
  // ticket." A gate pass rate far ABOVE its mean is the signature of that
  // defect, so a band that only flagged the direction bands.yaml calls bad
  // would report the temperature bug as a healthy system.
  it('flags an excursion in the good direction too, and says it is the good side', () => {
    const gate = METRICS.find((m) => m.name === 'gate_pass_rate')!;
    expect(gate.direction).toBe('low_is_bad');
    const at = (definition: typeof gate, value: number) =>
      evaluateMetric(definition, { day: '2026-02-01', value, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' }, spread).band;

    // Both directions of both senses, because asserting one arm of each let a
    // hardcoded `false` survive: a gate pass rate that COLLAPSED would then
    // have printed "the good direction", which is the real failure mode.
    expect(at(gate, 0.45)?.action).toBe('propose_change');
    expect(at(gate, 0.45)?.towardBad).toBe(false);   // low_is_bad, above
    expect(at(gate, -0.25)?.towardBad).toBe(true);   // low_is_bad, below

    const abstain = METRICS[0]!;
    expect(abstain.direction).toBe('high_is_bad');
    expect(at(abstain, 0.45)?.towardBad).toBe(true);  // high_is_bad, above
    expect(at(abstain, -0.25)?.towardBad).toBe(false); // high_is_bad, below
  });

  // The code and the sentence answer the same question. The delivery count is
  // why the code exists: its healthy state is flat, so it can never earn a
  // sigma, and the day it jumps is the day DEC-30 exists for.
  it('carries a machine-readable reason beside every sentence', () => {
    const flat = priorDays(Array.from({ length: WINDOW_DAYS }, () => 0));
    const moved = evaluateMetric(
      METRICS[3]!, { day: '2026-09-01', value: 50, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' }, flat);
    expect(moved.shortfallCode).toBe('moved_from_flat');
    expect(moved.shortfall).toContain('today moved to 50');

    const steady = evaluateMetric(
      METRICS[3]!, { day: '2026-09-01', value: 0, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' }, flat);
    expect(steady.shortfallCode).toBe('steady');

    const thin = evaluateMetric(
      METRICS[0]!, { day: '2026-09-01', value: 1, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' },
      priorDays([0, 0.2, 0]));
    expect(thin.shortfallCode).toBe('thin_window');

    const nan = evaluateMetric(
      METRICS[0]!, { day: '2026-09-01', value: Number.NaN, count: 10, notReached: 0, unrecorded: 0, pending: 0, provider: 'stub' },
      spread);
    // A value that is not a number fell through every comparison to the last
    // arm of the ladder, so it reported propose_change — a pull request.
    expect(nan.band).toBeNull();
    expect(nan.shortfallCode).toBe('day_not_a_number');
  });

  it('reports no band for a day that measured nothing', () => {
    const none = evaluateMetric(METRICS[0]!, { day: '2026-02-01', value: null, count: 0, notReached: 4, unrecorded: 0, pending: 0, provider: 'stub' }, spread);
    expect(none.band).toBeNull();
    expect(none.shortfall).toBe('the day measured nothing');
    // The fifth code, and the only one no case pinned. Mislabelled as
    // thin_window it would tell a consumer to wait for history that will
    // never help.
    expect(none.shortfallCode).toBe('day_unmeasured');
  });
});

// A valid artifact, which each case below breaks one rule at a time. Built
// from the definitions rather than written out, so a metric added to
// bands.yaml cannot leave this fixture silently one row short.
/** The shape an artifact written before the provider field existed has. */
function preProviderArtifactFixture(): Record<string, unknown> {
  const { provider: _dropped, ...rest } = artifactFixture();
  return rest;
}

function artifactFixture(): Record<string, unknown> {
  return {
    artifact: 'control-bands',
    version: 1,
    generated_at: '2026-02-01T00:00:00.000Z',
    role: 'observation',
    day: '2026-02-01',
    window_days: WINDOW_DAYS,
    runs: 10,
    provider: 'stub',
    metrics: METRICS.map((definition) => ({
      metric: definition.name,
      direction: definition.direction,
      value: 0.5,
      count: 8,
      not_reached: 2,
      unrecorded: 0,
      pending: 0,
      baseline: { mean: 0.4, sigma: 0.1, days: WINDOW_DAYS },
      band: { sigma_distance: 1, action: 'log', toward_bad: true },
      shortfall: null,
      shortfall_code: null,
    })),
  };
}

describe('the artifact write path', () => {
  it('refuses to replace an artifact another run already wrote', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bands-write-'));
    try {
      const base = pathToFileURL(dir + '/');
      const first = validateBandsArtifact(artifactFixture());
      await writeBandsArtifact(first, base);

      // The same version again. `rename` replaced the file and lost the first
      // run's bytes; `link` refuses, which is the promise this module makes.
      const second = { ...artifactFixture(), runs: 999 } as Record<string, unknown>;
      for (const metric of second['metrics'] as Record<string, unknown>[]) {
        metric['count'] = 999;
        metric['not_reached'] = 0;
      }
      await expect(writeBandsArtifact(validateBandsArtifact(second), base)).rejects.toThrow(
        /already exists; another run minted this version/,
      );

      // The first artifact survived, and no staging file was left behind.
      const kept = JSON.parse(readFileSync(join(dir, 'v1.json'), 'utf8')) as { runs: number };
      expect(kept.runs).toBe(10);
      expect(readdirSync(dir)).toEqual(['v1.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the control-band artifact', () => {
  // An adopter holds artifacts written before this field existed. Asserting
  // the key present made loadBandsArtifact throw on every one of them.
  it('accepts a report written before the provider field existed', () => {
    const raw = preProviderArtifactFixture();
    expect('provider' in raw).toBe(false);
    expect(() => validateBandsArtifact(raw)).not.toThrow();
    expect(validateBandsArtifact(raw).provider).toBeNull();
  });

  it('accepts a well-formed report', () => {
    expect(validateBandsArtifact(artifactFixture()).day).toBe('2026-02-01');
  });

  it('refuses a report whose counts do not add up to the day', () => {
    const raw = artifactFixture();
    (raw['metrics'] as Record<string, unknown>[])[1]!['not_reached'] = 1;
    expect(() => validateBandsArtifact(raw)).toThrow(/covers 9 runs, but the day held 10/);
  });

  // Two rules, two cases. A single case setting both fields was killed by the
  // code assert alone — its message is a prefix of the other's, so the regex
  // matched before execution ever reached the rule the case named, and
  // deleting that rule changed nothing.
  it('refuses a report that states a band and a shortfall code at once', () => {
    const raw = artifactFixture();
    const m = (raw['metrics'] as Record<string, unknown>[])[0]!;
    m['shortfall_code'] = 'thin_window';
    expect(() => validateBandsArtifact(raw)).toThrow(/reports a band and a shortfall code/);
  });

  it('refuses a report that states a band and a shortfall sentence at once', () => {
    const raw = artifactFixture();
    const m = (raw['metrics'] as Record<string, unknown>[])[0]!;
    m['shortfall'] = 'no baseline: 3 of 30 days';
    expect(() => validateBandsArtifact(raw)).toThrow(/reports a band and a shortfall$/);
  });

  // Reached by no case before: the fixture always carried a value.
  it('refuses a band placed over no value', () => {
    const raw = artifactFixture();
    const m = (raw['metrics'] as Record<string, unknown>[])[0]!;
    m['value'] = null;
    m['count'] = 0;
    m['not_reached'] = 10;
    expect(() => validateBandsArtifact(raw)).toThrow(/reports a band with no value/);
  });

  // The code vocabulary was unchecked: a shortfall could carry any string.
  it('refuses a shortfall code the vocabulary does not hold', () => {
    const raw = artifactFixture();
    const m = (raw['metrics'] as Record<string, unknown>[])[0]!;
    m['band'] = null;
    m['shortfall'] = 'no baseline: 3 of 30 days';
    m['shortfall_code'] = 'banana';
    expect(() => validateBandsArtifact(raw)).toThrow(/shortfall_code is banana/);
  });

  it('refuses a report that states neither, so a metric cannot go unanswered', () => {
    const raw = artifactFixture();
    const metric = (raw['metrics'] as Record<string, unknown>[])[0]!;
    metric['band'] = null;
    metric['shortfall'] = null;
    metric['shortfall_code'] = null;
    expect(() => validateBandsArtifact(raw)).toThrow(/no band and no shortfall/);
  });

  it('refuses a band with no baseline behind it', () => {
    const raw = artifactFixture();
    (raw['metrics'] as Record<string, unknown>[])[0]!['baseline'] = null;
    expect(() => validateBandsArtifact(raw)).toThrow(/band with no baseline/);
  });

  it('refuses a baseline built from fewer days than the window', () => {
    const raw = artifactFixture();
    (raw['metrics'] as Record<string, unknown>[])[0]!['baseline'] = {
      mean: 0.4, sigma: 0.1, days: WINDOW_DAYS - 1,
    };
    expect(() => validateBandsArtifact(raw)).toThrow(/covers 29 days, not 30/);
  });

  it('refuses a value reported over no runs at all', () => {
    const raw = artifactFixture();
    const metric = (raw['metrics'] as Record<string, unknown>[])[0]!;
    metric['count'] = 0;
    metric['not_reached'] = 10;
    expect(() => validateBandsArtifact(raw)).toThrow(/reports a value over 0 runs/);
  });

  it('refuses a metric row that is not the one the definitions expect', () => {
    const raw = artifactFixture();
    (raw['metrics'] as Record<string, unknown>[])[0]!['metric'] = 'gate_pass_rate';
    expect(() => validateBandsArtifact(raw)).toThrow(/expected abstain_rate/);
  });

  it('refuses a report missing a metric, so nothing goes unlooked at', () => {
    const raw = artifactFixture();
    raw['metrics'] = (raw['metrics'] as unknown[]).slice(1);
    expect(() => validateBandsArtifact(raw)).toThrow(/holds 3 rows, expected 4/);
  });

  it('refuses a day the calendar does not hold', () => {
    const raw = artifactFixture();
    raw['day'] = '2026-02-30';
    expect(() => validateBandsArtifact(raw)).toThrow(/not a day the calendar holds/);
  });

  it("refuses a file that calls itself anything but an observation", () => {
    const raw = artifactFixture();
    raw['role'] = 'correction';
    expect(() => validateBandsArtifact(raw)).toThrow(/not 'observation'/);
  });
});

// The module reads a live ledger, so the claim that it cannot damage one is
// enforced rather than stated. The promise is made at command scope, so the
// scan covers every module the command loads that can reach the pool.
// Every module of the job, discovered rather than listed. A hardcoded list
// does not grow when a module does, so a new file that took the pool would
// never have been scanned at all.
const READ_ONLY_MODULES = readdirSync(join(REPO_ROOT, 'src/bands'))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => `src/bands/${name}`);

/**
 * Source with comments blanked, so prose about writing never trips the scan.
 *
 * SQL comments are stripped too, because a column name survives inside one and
 * an earlier guard of this shape passed its own mutation twice. Only a line
 * that is entirely a SQL comment is removed: blanking from any `--` onward
 * also blanked the rest of `args.indexOf('--day')`, which hid every statement
 * written after it on that line.
 */
function codeOf(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n');
}

describe('the bands command never writes', () => {
  it.each(READ_ONLY_MODULES)('issues no statement in %s that could change the ledger', (module) => {
    const code = codeOf(module);
    for (const verb of [
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'GRANT',
      'MERGE', 'COPY', 'REFRESH', 'VACUUM', 'CALL',
    ]) {
      expect(code, `${module} contains a ${verb} statement`).not.toMatch(
        new RegExp(`\\b${verb}\\b`, 'i'),
      );
    }
  });

  // A positive control for each scanned module, not just the one holding SQL.
  // `run.ts` contains no statement at all once comments are stripped, so its
  // row in the scan above was true of an empty file too.
  it('still sees each module, so the scan is not passing over nothing', () => {
    expect(READ_ONLY_MODULES).toContain('src/bands/query.ts');
    expect(READ_ONLY_MODULES).toContain('src/bands/run.ts');
    expect(codeOf('src/bands/query.ts')).toMatch(/\bSELECT\b/);
    // run.ts owns the pool; that is why it is scanned.
    expect(codeOf('src/bands/run.ts')).toMatch(/new Pool\(/);
  });

  // The text scan can only refuse what it knows to look for, and it cannot see
  // a write issued from inside a SELECT. The connection itself refuses.
  it('opens its connection read-only at the server', () => {
    expect(codeOf('src/bands/run.ts')).toContain('default_transaction_read_only=on');
  });

  // The blocklist is over column names, so it is blind to the one payload the
  // query does read. Only these keys may be extracted from it.
  //
  // Three now, not two. Issue #23 added `provider`, which holds the answerer's
  // kind — the literal string 'stub' or 'model' — and never a payload, a
  // prompt or a completion. A fourth key is a widening of what this report can
  // carry out of the journal, so it belongs here with its reason, and DEC-18
  // decides whether it may be added at all.
  it('extracts no jsonb key from the journal beyond the three it needs', () => {
    const code = codeOf('src/bands/query.ts');
    // Every quoted literal near the payload, not only the arrow syntaxes. A
    // first version matched `result->'x'` alone, so
    // `jsonb_extract_path_text(result, 'customer_email')` walked straight
    // past it — and the companion blocklist below is over six column names,
    // so it did not catch that either.
    // Every identifier character, not lowercase alone. A future
    // `result->>'customerEmail'` kept the sorted-equality assertion green
    // under `[a-z_]+` — the key simply did not match — and it evades the
    // extraction-syntax blocklist below too. The DEC-18 guard on the one
    // payload this report reads would have passed on the widening it exists
    // to refuse.
    const keys = [...code.matchAll(/result[^\n]*?'([A-Za-z0-9_]+)'/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    expect([...new Set(keys)].sort()).toEqual(['abstained', 'provider', 'reason']);
    // And no other extraction syntax reaches the payload at all.
    for (const form of ['jsonb_extract_path', 'jsonb_path_query', '#>', '#>>']) {
      expect(code, `query.ts extracts from the journal with ${form}`).not.toContain(form);
    }
  });

  // The stripper must not blank code that merely contains two dashes. The CLI
  // reads `--day`, and a version that stripped from any `--` hid everything
  // after it on that line.
  it('strips a SQL comment line without blanking code that contains dashes', () => {
    const code = codeOf('src/bands/run.ts');
    expect(code).toContain("indexOf('--day')");
    expect(codeOf('src/bands/query.ts')).not.toContain('The status test matters');
  });

  // The report reads counts, numbers and a day. Customer text in this file
  // would put it in an artifact that has no reason to hold any (DEC-18).
  it('selects no case text and no case identifier', () => {
    const code = codeOf('src/bands/query.ts');
    for (const column of ['ticket_text', 'subject', 'body', 'message_id', 'ticket_id', 'sender']) {
      expect(code, `query.ts reads ${column}`).not.toContain(column);
    }
  });
});

describe('the operator-facing helpers', () => {
  it('defaults to the most recent complete UTC day, never to today', () => {
    expect(lastCompleteDay(new Date('2026-03-02T00:30:00.000Z'))).toBe('2026-03-01');
    // Across a month boundary, and across a leap day.
    expect(lastCompleteDay(new Date('2026-03-01T23:59:59.000Z'))).toBe('2026-02-28');
  });

  it('refuses a day it cannot parse, naming what to type', () => {
    const now = new Date('2026-09-04T10:00:00.000Z');
    expect(() => parseDay('yesterday', now)).toThrow(/UTC calendar day/);
    expect(() => parseDay('2026-02-30', now)).toThrow(/UTC calendar day/);
    expect(parseDay('2026-02-28', now)).toBe('2026-02-28');
  });

  // Bounded, not merely well formed. A day still running compares part of it
  // against whole days; a far future day minted a versioned artifact of nulls
  // that reads in the record exactly like a real quiet day.
  it('refuses a day that has not finished, and one from the far future', () => {
    const now = new Date('2026-09-04T10:00:00.000Z');
    expect(parseDay('2026-09-03', now)).toBe('2026-09-03');
    expect(() => parseDay('2026-09-04', now)).toThrow(/has not finished/);
    expect(() => parseDay('2099-01-01', now)).toThrow(/has not finished/);
    expect(() => parseDay('0001-01-01', now)).toThrow(/before the ledger/);
  });

  it('refuses to name a day from an invalid clock rather than throwing a range error', () => {
    expect(() => lastCompleteDay(new Date('not a date'))).toThrow(/invalid date/);
  });

  it('renders a rate to three places and a count whole', () => {
    expect(humanValue(null)).toBe('-');
    expect(humanValue(0)).toBe('0');
    expect(humanValue(3)).toBe('3');
    expect(humanValue(1 / 3)).toBe('0.333');
  });

  it('states the action, the distance, the side and whether the side is bad', () => {
    expect(bandLine('diagnose', -2.31, true)).toBe(
      'diagnose, 2.3 sigma below the mean (the bad direction)',
    );
    expect(bandLine('propose_change', 3.5, false)).toBe(
      'propose_change, 3.5 sigma above the mean (the good direction)',
    );
  });
});

describe('the artifact directory', () => {
  it("is ignored, because a daily sample is the adopter's own traffic", () => {
    const ignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\/bands\/$/m);
  });

  it('is reachable by a named command, so the runbook can name one', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['bands']).toContain('dist/bands/run.js');
  });
});
