// The resume file that lets a five-hour scoring pass survive an outage.
//
// A coverage pass over one half makes some four thousand calls across hours,
// and it held nothing between them. Three runs died and each discarded every
// draft scored before it: one on a provider having a bad hour, one on a
// connect timeout that outlasted every retry, and one on a killed shell. The
// retry rides out a short outage. Nothing rode out a long one.
//
// Each scored draft is appended as it lands, so a run that dies continues from
// where it stopped instead of starting over.
//
// The file records a hash of each ticket id, never the id. On a real half that
// value is a Message-ID carrying the customer's domain, and this file sits on
// disk beside the corpus (DEC-18). A hash matches on resume just as well.
//
// The header names the run: the model, the prompt and the half it scored. A
// file from a different run describes different samples, and mixing two runs
// would publish a number from neither, so a mismatch refuses rather than
// starting over silently.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CoverageSample } from './fit.js';

export interface ResumeKey {
  readonly modelVer: string;
  readonly promptVer: string;
  readonly split: string;
  /** Which CASES the run covered. The DEC-31 proof reads this one. */
  readonly halfDigest: string;
  /**
   * What the judge was actually asked: the claim sentences, their labels and
   * the bodies they are judged against.
   *
   * The half digest cannot see any of that. Edit a claim's wording, flip a
   * support label or rewrite a cited document under fixed ticket ids, and a
   * resumed run reuses samples scored against text that no longer exists.
   *
   * Optional, so a file written before this field existed still resumes. Such
   * a file is accepted with a warning rather than refused: it may well cover
   * the same work, and discarding hours of paid-for scoring on a suspicion is
   * the loss this whole file exists to prevent.
   */
  readonly inputDigest?: string;
}

/** What one draft cost, and whether that figure is a total or a floor (DEC-25). */
export interface ResumeCost {
  readonly costMicros: number;
  readonly costUnknown: boolean;
}

export interface ResumeStore {
  /** Hashed ticket id to its sample, or null for a draft the judge could not score. */
  readonly done: Map<string, CoverageSample | null>;
  /**
   * Hashed ticket id to what that draft cost.
   *
   * Recorded beside the sample so a resumed run reports what the whole fit
   * cost, not what its final attempt cost. A row written before this field
   * existed is absent here, and the reader marks the total a floor rather
   * than counting the draft as free.
   */
  readonly cost: Map<string, ResumeCost>;
  record(ticketId: string, sample: CoverageSample | null, cost: ResumeCost): Promise<void>;
  idKey(ticketId: string): string;
}

function hashId(ticketId: string): string {
  return createHash('sha256').update(ticketId).digest('hex').slice(0, 16);
}

/** A value read back from disk is a sample only if it carries every field the fit reads. */
function isSample(value: unknown): value is CoverageSample {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<CoverageSample>;
  return typeof s.coverage === 'number'
    && Number.isFinite(s.coverage)
    && s.coverage >= 0
    && s.coverage <= 1
    && typeof s.grounded === 'boolean'
    && (s.grade === null || typeof s.grade === 'string');
}

/**
 * Refuse a file another live run already holds.
 *
 * Both coverage CLIs default to one fixed path, so two runs started by
 * mistake share a file. Each reads the same `done` snapshot at open, so each
 * pays for every unfinished draft: hours and dollars doubled, silently, in the
 * one file whose whole purpose is not paying twice. The truncation of a torn
 * tail can also cut a row the other run has just appended.
 *
 * The lock names the process holding it, and a dead owner is taken over
 * rather than obeyed. A stale lock that outlived a crash would block the
 * resume this file exists to enable, which is a worse failure than the one
 * being prevented. Nothing releases the lock on exit for the same reason: the
 * liveness check is what makes it correct, so a crash needs no cleanup.
 */
async function claimLock(file: string): Promise<void> {
  const lock = `${file}.lock`;
  let held: { pid?: number } | null = null;
  try {
    held = JSON.parse(await readFile(lock, 'utf8')) as { pid?: number };
  } catch {
    held = null;
  }
  if (held !== null && typeof held.pid === 'number' && held.pid !== process.pid) {
    if (isAlive(held.pid)) {
      throw new Error(
        `resume file ${file} is held by a running job, process ${held.pid}. Two runs on one `
          + 'file each pay for every draft the other has not finished yet. Wait for it, or '
          + 'point this run at another path with GROUNDEDNESS_RESUME',
      );
    }
    console.warn(
      `resume file ${file} was left locked by process ${held.pid}, which is gone. Taking it over`,
    );
  }
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
}

/** Whether a process id still names a running process. Signal 0 tests, never kills. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which is still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function openResume(file: string, key: ResumeKey): Promise<ResumeStore> {
  await claimLock(file);
  const done = new Map<string, CoverageSample | null>();
  const cost = new Map<string, ResumeCost>();
  let text: string | null = null;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    // Only a missing file is a fresh start. Any other fault, a permission or
    // a disk error, would discard every draft the file holds and append a
    // second header after them.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `resume file ${file} cannot be read: ${(error as Error).message}. `
          + 'Fix the disk or the permission and start again; the file still holds the drafts it recorded',
        { cause: error },
      );
    }
    text = null;
  }

  if (text !== null && text.trim() !== '') {
    // A killed writer is one of the three deaths this file exists to survive,
    // and it leaves a torn last line. That tail is dropped rather than read,
    // and the file is cut back to the last complete line: appending onto a
    // partial line would splice two records into one that no later run could
    // read. A tail is a torn write only when the file does not end in a
    // newline. Anywhere else an unreadable line is corruption, and the run
    // still refuses rather than guessing which drafts it lost.
    let body = text;
    if (!body.endsWith('\n')) {
      const lastBreak = body.lastIndexOf('\n');
      const keep = lastBreak === -1 ? 0 : lastBreak + 1;
      console.warn(
        `resume file ${file} ends in a partial line, which is what a killed `
          + 'writer leaves. Dropping that line and keeping every draft before it',
      );
      await truncate(file, keep);
      body = body.slice(0, keep);
      text = body;
    }
    const lines = body.split('\n').filter((l) => l.trim() !== '');
    // Nothing survived the cut, which is a writer killed partway through the
    // header itself. There is no work to lose and no run to describe, so this
    // starts cleanly below rather than refusing. Refusing here failed a run
    // over a file holding no drafts at all, and told the operator to delete a
    // file this code had already emptied.
    if (lines.length > 0) {
      let header: unknown;
      try {
        header = JSON.parse(lines[0] as string);
        if (header === null || typeof header !== 'object' || Array.isArray(header)) throw new Error('no object');
      } catch {
        throw new Error(
          `resume file ${file} does not begin with a run header this job wrote. `
            + 'Delete it to start over, or point the job at another path',
        );
      }
      const h = header as Partial<ResumeKey> & { header?: boolean };
      if (
        key.inputDigest !== undefined && h.inputDigest !== undefined
        && h.inputDigest !== key.inputDigest
      ) {
        throw new Error(
          `resume file ${file} was scored against different claims or different documents. `
            + 'The cases match, but what the judge was asked does not, so its samples answer '
            + 'questions this run is not asking. Delete it to start over',
        );
      }
      if (key.inputDigest !== undefined && h.inputDigest === undefined) {
        console.warn(
          `resume file ${file} was written before the input digest existed, so this run cannot `
            + 'check that its claims and documents are unchanged. It resumes on that assumption',
        );
      }
      if (
        h.modelVer !== key.modelVer || h.promptVer !== key.promptVer
        || h.split !== key.split || h.halfDigest !== key.halfDigest
      ) {
        throw new Error(
          `resume file ${file} describes a different run: it holds `
            + `${String(h.split)}/${String(h.modelVer)}/${String(h.promptVer)} and this run is `
            + `${key.split}/${key.modelVer}/${key.promptVer}. Mixing two runs' samples would `
            + 'publish a number from neither. Delete it to start over',
        );
      }
      for (const line of lines.slice(1)) {
        let row: {
          id?: string;
          sample?: CoverageSample | null;
          cost_micros?: number;
          cost_unknown?: boolean;
        };
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('no object');
          row = parsed as typeof row;
        } catch {
          throw new Error(
            `resume file ${file} holds a line this job cannot read. Delete it to start over`,
          );
        }
        // A second header comes from an earlier job that read a file it could
        // not open as a fresh start, and wrote its own header after the drafts.
        // It counts only when it describes the run the first header does:
        // otherwise the samples after it come from another run. The check
        // compares its input digest with each digest that exists, as it does
        // for the first header, so a file whose header has no input digest
        // still resumes, with the same warning. Any other row without
        // a draft id is damage, and skipping it would hide a lost draft behind
        // a run that looks complete.
        if ((row as { header?: unknown }).header === true) {
          const later = row as Partial<ResumeKey>;
          const fields = ['modelVer', 'promptVer', 'split', 'halfDigest'] as const;
          const digestDiffers = later.inputDigest !== undefined
            && [h.inputDigest, key.inputDigest].some(
              (digest) => digest !== undefined && digest !== later.inputDigest,
            );
          if (digestDiffers || fields.some((field) => later[field] !== h[field])) {
            throw new Error(
              `resume file ${file} holds a second run header that describes a different run. `
                + "Mixing two runs' samples would publish a number from neither. Delete it to start over",
            );
          }
          if (later.inputDigest === undefined && (h.inputDigest ?? key.inputDigest) !== undefined) {
            console.warn(
              `resume file ${file}: its second run header was written before the input digest existed, `
                + 'so this run cannot check the claims and documents of the drafts after it. '
                + 'It resumes on that assumption',
            );
          }
          continue;
        }
        if (typeof row.id !== 'string') {
          throw new Error(
            `resume file ${file} holds a line this job cannot read. Delete it to start over`,
          );
        }
        // The sample's shape is checked here, at the one place a value re-enters
        // the run from disk. The fit job validates its samples; the report job
        // reads them straight out of this map, so a JSON-valid row holding a
        // string coverage would have moved a published number silently.
        const held = row.sample ?? null;
        if (held !== null && !isSample(held)) {
          throw new Error(
            `resume file ${file} holds a row whose sample this job cannot read. `
              + 'Delete it to start over',
          );
        }
        // A draft that the file records twice, after a second header, has
        // two scorings, and the job pays for each. So its spend is the sum,
        // and a scoring of unknown spend keeps the sum a floor.
        const seen = done.has(row.id);
        const earlier = cost.get(row.id);
        done.set(row.id, held);
        if (typeof row.cost_micros === 'number' && Number.isFinite(row.cost_micros)) {
          cost.set(row.id, {
            costMicros: (earlier?.costMicros ?? 0) + row.cost_micros,
            costUnknown: (earlier?.costUnknown ?? seen) || row.cost_unknown === true,
          });
        } else if (earlier !== undefined) {
          cost.set(row.id, { ...earlier, costUnknown: true });
        }
      }
    }
  }

  if (text === null || text.trim() === '') {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify({ header: true, ...key }) + '\n');
  }

  return {
    done,
    cost,
    idKey: hashId,
    async record(ticketId, sample, spent) {
      const id = hashId(ticketId);
      done.set(id, sample);
      cost.set(id, spent);
      await appendFile(
        file,
        JSON.stringify({
          id, sample, cost_micros: spent.costMicros, cost_unknown: spent.costUnknown,
        }) + '\n',
      );
    },
  };
}
