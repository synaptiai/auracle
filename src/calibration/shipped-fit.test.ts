// What the per-intent fit does on the shipped corpus (issue #39, DEC-41).
//
// DEC-41 fits a threshold for each intent above the labelled-case trigger.
// The shipped corpus clears that trigger, so the path runs. This file records
// what it produces, because nothing else does: the calibration directory is
// ignored, so no artifact is committed and no reader can check the claim
// against one.
//
// The run uses the offline stand-in from `src/replay/fake-model.ts`. It
// matches fixture phrases and reaches no network, so these figures cost
// nothing and repeat exactly. They are not a measurement of a classifier.
//
// Two things decide the outcome, and the record must name both. One is the
// corpus, which spreads its cases over the taxonomy on a Zipf curve. The
// other is the target precision, which `CALIBRATION_TARGET_PRECISION`
// overrides. A case below runs a second fit at a lower target to show that a
// refusal is a property of the pair and not of the corpus alone.
//
// Section 3.3 sizes the trigger from a premise: intent frequencies obey a
// Zipf distribution, and the intent at rank 20 needs a corpus of about 7700
// tickets. The shipped corpus now obeys that premise, so the last block reads
// the corpus rather than stating what the premise would give.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_TARGET_PRECISION, runCalibrationJob } from './run.js';
import { minimumSupport } from './calibrate.js';
import type { CalibrationArtifact } from './artifact.js';
import { FIT_COUNT, INTENT_CAP } from '../domain/gold-types.js';
import { loadGoldHalf, loadTaxonomy, readHalfIdentity } from '../fixtures/load.js';
import type { GoldFile } from '../domain/gold-types.js';
import type { Taxonomy } from '../domain/gold-types.js';
import { ReplayStubProvider } from '../replay/fake-model.js';
import { normalizeIntentId } from '../policy/policy.js';

/** The pin the offline stand-in reports, as `src/goldreport/run.ts` names it. */
const STUB_MODEL_VER = 'replay-stub';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A target no operator would ship. It exists to show the knob moves. */
const LENIENT_TARGET = 0.9;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the real job with the stand-in, into a directory of its own.
 *
 * Inside `beforeAll` rather than at module scope. A run at module scope
 * happens during collection, so a filtered run pays for 4100 classifications
 * and then leaks its directory, because no case ran and no hook fired.
 */
async function fit(targetPrecision?: number): Promise<CalibrationArtifact> {
  const dir = mkdtempSync(join(tmpdir(), 'auracle-shipped-fit-'));
  dirs.push(dir);
  const result = await runCalibrationJob({
    provider: new ReplayStubProvider(),
    modelVer: STUB_MODEL_VER,
    artifactDir: pathToFileURL(`${dir}/`),
    ...(targetPrecision === undefined ? {} : { targetPrecision }),
  });
  return result.artifact;
}

let fitHalf: GoldFile;
// The fixtures' taxonomy, which carries the risk tier. The classifier's
// own shape drops it, and one case below reads it.
let taxonomy: Taxonomy;
/** The intents the taxonomy declares. `INTENT_CAP` is a cap, not a count. */
let INTENT_COUNT: number;

/**
 * Fit cases each intent holds, keyed the way the fit keys them.
 *
 * Counted from the corpus, never divided out of a total. The shape is the
 * property under test, and a total divided by a count reads the same on any
 * shape at all.
 */
let casesPerIntent: Map<string, number>;

function countCasesPerIntent(): Map<string, number> {
  const byIntent = new Map<string, number>();
  for (const ticket of fitHalf.tickets) {
    const key = normalizeIntentId(ticket.intent);
    byIntent.set(key, (byIntent.get(key) ?? 0) + 1);
  }
  return byIntent;
}

let shipped: CalibrationArtifact;
let lenient: CalibrationArtifact;

beforeAll(async () => {
  // The loaders live here for the same reason `fit()` does. At module scope
  // a validation fault in the corpus is a collection error, so the file
  // reports no cases and a reader sees an absence where a red row belongs.
  fitHalf = loadGoldHalf('fit');
  taxonomy = loadTaxonomy();
  INTENT_COUNT = taxonomy.intents.length;
  casesPerIntent = countCasesPerIntent();
  shipped = await fit();
  lenient = await fit(LENIENT_TARGET);
}, 120_000);

describe('the per-intent fit on the shipped corpus', () => {
  it('runs, because the corpus clears the trigger', () => {
    // Counted, not divided. `run.ts` derives the labelled count from the fit
    // half's length and a constant for the counterpart, so comparing the
    // artifact against that same constant would compare it with itself. The
    // counterpart is read from the report half's identifiers instead, which
    // carry no case text (DEC-31).
    const counterpart = readHalfIdentity(join(REPO_ROOT, 'fixtures/gold/report.json'), 'report');
    expect(shipped.labelled_cases).toBe(fitHalf.tickets.length + counterpart.ticketIds.size);
    expect(shipped.trigger_min_labelled, 'the run recorded no trigger').toBeDefined();
    expect(
      shipped.labelled_cases!,
      'the corpus no longer clears the trigger, so the per-intent path did not run',
    ).toBeGreaterThanOrEqual(shipped.trigger_min_labelled!);
  });

  it('fits the intents that clear the floor, and names every intent it refuses', () => {
    // Defined first. `?? {}` alone passes when the field is absent, so a run
    // that never triggered would satisfy a count of zero.
    expect(shipped.per_intent, 'the run wrote no per-intent map at all').toBeDefined();
    const fitted = Object.keys(shipped.per_intent ?? {});
    // Counted from the corpus against the floor, not written here. A literal
    // 4 would pass on a corpus reshaped to any curve that happens to put four
    // intents over the line, and it would need editing every time the target
    // moved.
    const floor = minimumSupport(DEFAULT_TARGET_PRECISION);
    const clearing = [...casesPerIntent]
      .filter(([, cases]) => cases >= floor)
      .map(([intent]) => intent);
    expect(clearing.length, 'no intent clears the floor, so the fit proves nothing here')
      .toBeGreaterThan(0);
    expect(new Set(fitted), 'the fitted set is not the set that clears the floor')
      .toEqual(new Set(clearing));
    expect(shipped.below_floor, 'the run wrote no refusal list at all').toBeDefined();
    expect(shipped.below_floor).toHaveLength(INTENT_COUNT - clearing.length);
    // Against the taxonomy, not against the cap. Twenty-five ids that the
    // taxonomy does not declare would satisfy a bare count.
    const declared = new Set(taxonomy.intents.map((intent) => normalizeIntentId(intent.id)));
    const refused = shipped.below_floor ?? [];
    // Distinct, because a length alone accepts one intent named 25 times.
    expect(new Set(refused).size).toBe(refused.length);
    for (const intent of refused) {
      expect(declared, `${intent} is refused but the taxonomy does not declare it`)
        .toContain(intent);
    }
    expect(new Set(casesPerIntent.keys())).toEqual(declared);
  });

  it('rests each refusal on the sample count, and each fit on the count and the answers', () => {
    // `fitAgreementThreshold` reads the 95 per cent lower bound, and a
    // perfect sample of n reaches n / (n + 3.8415). So an intent under the
    // floor is refused however accurate the answers are, and an intent over
    // it is fitted only because the answers also hold.
    //
    // Every refusal is therefore over-determined and needs no measurement.
    // No fit is: the stand-in's accuracy carries the other half of it, and
    // the case below records that accuracy beside the result.
    const floor = minimumSupport(DEFAULT_TARGET_PRECISION);
    const fitted = new Set(Object.keys(shipped.per_intent ?? {}));
    for (const [intent, cases] of casesPerIntent) {
      if (fitted.has(intent)) {
        expect(cases, `${intent} is fitted without clearing the floor`)
          .toBeGreaterThanOrEqual(floor);
      } else {
        expect(cases, `${intent} is refused while holding enough cases, so precision decided it`)
          .toBeLessThan(floor);
      }
    }
    // Recorded beside it: the stand-in was exactly accurate. Precision is the
    // share correct among the cases that passed the threshold, so coverage
    // belongs in the same case. The pair is what makes every case correct.
    expect(
      shipped.precision_at_threshold,
      'the stand-in answered a fit case wrongly, so precision is no longer the recorded 1.0',
    ).toBe(1);
    expect(
      shipped.coverage_at_threshold,
      'a fit case sat below the threshold, so precision no longer covers every case',
    ).toBe(1);
  });

  it('refuses because of the target as much as the corpus', () => {
    // The same corpus and the same answers, at a lower target. The target
    // reaches the job as a parameter, and `main()` fills that parameter from
    // CALIBRATION_TARGET_PRECISION. So this measures the parameter, which is
    // where the value lands, and not the reading of the variable.
    //
    // Every intent now fits, and every
    // fitted threshold is 1.0, because the stand-in gives one agreement value
    // and a threshold needs a value to sit at. So the shipped refusal is a
    // property of the pair, and the roadmap must say which target it names.
    expect(lenient.per_intent, 'the lenient run wrote no per-intent map').toBeDefined();
    expect(
      Object.keys(lenient.per_intent ?? {}),
      'the lenient target did not fit every intent',
    ).toHaveLength(INTENT_COUNT);
    expect(lenient.below_floor, 'the lenient target still refused an intent').toHaveLength(0);
    expect(
      new Set(Object.values(lenient.per_intent ?? {})),
      'a fitted threshold differs from 1.0, so the stand-in gave more than one agreement value',
    ).toEqual(new Set([1]));
    for (const [intent, cases] of casesPerIntent) {
      expect(cases, `${intent} is fitted at the lenient target without clearing its floor`)
        .toBeGreaterThanOrEqual(minimumSupport(LENIENT_TARGET));
    }
  });

  it('fits a threshold only where the gate can read one', () => {
    // `evaluatePolicy` returns `gated` for a high-risk intent before it
    // compares agreement, so a threshold fitted for such an intent is never
    // read. A corpus whose most frequent intents are the high-risk ones
    // therefore fits four thresholds that decide nothing, and the per-intent
    // path stays unexercised while every count says otherwise.
    //
    // The taxonomy lists the high-risk intents first, so ranking the curve by
    // that order put all four fitted intents beyond the gate's reach. The
    // generator names its own frequency order for this reason.
    const tiers = new Map(taxonomy.intents.map((i) => [normalizeIntentId(i.id), i.risk_tier]));
    // An empty map iterates zero times and proves nothing, and `?? {}` would
    // absorb a missing one. This case is the only guard on the rank order, so
    // it fails rather than passing vacuously.
    expect(shipped.per_intent, 'the run wrote no per-intent map').toBeDefined();
    const fittedIntents = Object.keys(shipped.per_intent ?? {});
    expect(fittedIntents.length, 'no intent was fitted, so this case checks nothing')
      .toBeGreaterThan(0);
    for (const intent of fittedIntents) {
      expect(tiers.get(intent), `the taxonomy does not declare ${intent}`).toBeDefined();
      expect(
        tiers.get(intent),
        `${intent} is fitted a threshold, and a high-risk intent gates before agreement is read`,
      ).not.toBe('high');
    }
  });

  it('records the target the shipped default names', () => {
    expect(DEFAULT_TARGET_PRECISION, 'the shipped default target moved').toBe(0.985);
    expect(
      minimumSupport(DEFAULT_TARGET_PRECISION),
      'the samples a perfect fit needs at the shipped target moved',
    ).toBe(253);
    expect(shipped.target_precision, 'the run fitted at a target it was not given')
      .toBe(DEFAULT_TARGET_PRECISION);
    // The shape, not one intent. The counts are read from the corpus and
    // compared against the curve, so naming a fixture id is never needed.
    const harmonic = Array.from({ length: INTENT_COUNT }, (_, i) => 1 / (i + 1))
      .reduce((a, b) => a + b, 0);
    const ranked = [...casesPerIntent.values()].sort((a, b) => b - a);
    // A short map would iterate fewer times and still pass, so the shape
    // claim in the title would go unchecked.
    expect(ranked, 'the corpus lost an intent').toHaveLength(INTENT_COUNT);
    ranked.forEach((cases, index) => {
      const earned = FIT_COUNT / harmonic / (index + 1);
      expect(Math.abs(cases - earned), `rank ${index + 1} holds ${cases}, and earns ${earned.toFixed(1)}`)
        .toBeLessThanOrEqual(1);
    });
  });
});

describe('a Zipf shape at exponent one, as arithmetic', () => {
  // Section 3.3 states that intent frequencies obey a Zipf distribution and
  // it names no exponent. This block assumes one, which is the classic shape
  // and the only one the register's wording supports. The counts below move
  // with that assumption and the case titles say so.
  //
  // Nothing here is measured. Holding enough cases is necessary for an intent
  // to be fitted and it is never sufficient: whether a candidate threshold
  // passes that many cases at a lower bound over the target depends on the
  // agreement distribution, which this block does not have.
  // The cap is the subject here: section 4.11 sizes the taxonomy at 25, and
  // the register's arithmetic is written for that number.
  const harmonic = Array.from({ length: INTENT_CAP }, (_, i) => 1 / (i + 1))
    .reduce((a, b) => a + b, 0);
  const fitCasesAtRank = (rank: number): number => FIT_COUNT / harmonic / rank;

  it('gives the most frequent intent many cases and the rarest few', () => {
    expect(Math.round(fitCasesAtRank(1))).toBe(1074);
    expect(Math.round(fitCasesAtRank(INTENT_CAP))).toBe(43);
  });

  it('reaches the sample floor for four intents of twenty-five, which is necessary and not sufficient', () => {
    const floor = minimumSupport(DEFAULT_TARGET_PRECISION);
    const reached = Array.from({ length: INTENT_CAP }, (_, i) => fitCasesAtRank(i + 1))
      .filter((cases) => cases >= floor);
    expect(reached).toHaveLength(4);
    // The corpus now carries that shape, so the arithmetic and the fixture
    // agree rather than contrasting. The fit reads the corpus, so this
    // compares the two rather than restating one.
    const clearing = [...casesPerIntent.values()].filter((cases) => cases >= floor);
    expect(clearing, 'the corpus no longer clears the floor for the ranks the curve names')
      .toHaveLength(reached.length);
  });
});
