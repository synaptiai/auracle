// What the repository says about the partition key (DEC-36).
//
// DEC-36 made the partition key the conversation id, and the ticket id the
// fallback for a run that has no conversation. The schema comment was
// corrected when the decision landed; two source headers were not, and they
// kept describing the queue as keyed on a hash of the ticket id.
//
// A comment cannot fail a build, so a reader is the only thing that catches
// this. That is what let one correction stand for a class and miss two
// members of it. This case reads the shipped trees instead.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { partitionOf } from './coordinator.js';
import { isFrozenRecord } from '../test-support/frozen-records.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
/** This suite states the stale spellings, so it must not scan itself. */
const SELF = new URL(import.meta.url).pathname;
const SHIPPED_TREES = ['src', 'docs', 'db', 'intent', 'scripts', 'evals'];
const SHIPPED_FILES = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'REVIEW.md'];

function shippedFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) shippedFiles(path, acc);
    else if (/\.(ts|md|sql)$/.test(entry)) acc.push(path);
  }
  return acc;
}

describe('the partition key the repository states (DEC-36)', () => {
  it('is never described as a hash of the ticket id alone', () => {
    // Assembled from parts so this suite does not match itself.
    // An alternation, not one literal: the stale claim restates itself as
    // 'hash(ticketId)' or 'partitioned by ticket id', and a guard that pins
    // one spelling is the same class-for-member mistake it exists to catch.
    const t = 'ticket';
    const stale = new RegExp(
      `hash\\(${t}_?[iI]d\\)`
        + `|partition(ed|s)? (the queue )?by [^.\\n]{0,16}${t}`
        // The conclusion the register retracted, not just the key it named.
        // One consumer per partition stops two runs on one conversation; a
        // run with no conversation hashes on the ticket and lands elsewhere.
        + `|two runs on one ${t} cannot`,
      'i',
    );
    const files = [
      ...SHIPPED_TREES.flatMap((tree) => shippedFiles(join(REPO_ROOT, tree))),
      ...SHIPPED_FILES.map((name) => join(REPO_ROOT, name)),
    ]
      .filter((path) => path !== SELF)
      // A frozen record states the partition key as it stood when the
      // record was written. Two do say the ticket id alone, and both
      // predate DEC-36 (issue #79).
      .filter((path) => !isFrozenRecord(path));
    const naming = files
      .filter((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          // A decision row records what was decided then. DEC-27 said the
          // ticket id and DEC-36 replaced it, and the register keeps both
          // rows: a decision cannot be rewritten. Prose about how the system
          // works today can, and must.
          .filter((line) => !/^\|\s*DEC-\d+\s*\|/.test(line))
          .some((line) => stale.test(line)),
      )
      .map((path) => path.slice(REPO_ROOT.length));
    expect(naming).toEqual([]);
  });

  it('sends every turn of one conversation to one partition', () => {
    const first = partitionOf('CONV-1', 8);
    const second = partitionOf('CONV-1', 8);
    expect(second).toBe(first);
  });

  it('lands every key inside the partition count', () => {
    // The fallback to the ticket id is chosen by the caller, not here; this
    // function only has to place whatever key it is given.
    for (const key of ['CONV-1', 'TICKET-1', '', 'CONV-999']) {
      const partition = partitionOf(key, 8);
      expect(partition).toBeGreaterThanOrEqual(0);
      expect(partition).toBeLessThan(8);
    }
  });
});
