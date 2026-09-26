// The artifact an end-to-end case writes at its end (AGENTS.md, "How to test
// a change", rule 3).
//
// A case records its inputs, its seed and the end state it observed. At its
// end the case renders them to stable JSON and compares that text with the
// artifact committed under src/e2e/artifacts/. The same inputs must give the
// same bytes, so a difference is a behaviour change or a determinism leak.
// Either way the case fails, and the new text is left beside the golden as
// `<case>.actual.json`, which git ignores. The golden itself never changes
// unless AURACLE_E2E_ACCEPT=1 is set, so a rerun after a failure fails again.
// To accept a change, rerun with that variable, review `git diff`, and commit.
//
// A timestamp becomes one `<time>` token, so the artifact does not check any
// time value. The cases assert the times that matter themselves.
//
// Values that change from run to run by design become tokens: a uuid is
// `<uuid:n>`, a timestamp is `<time>`, and a value the case registers is
// `<kind:n>`. The number is the order of first appearance, so the artifact
// still shows that two places hold the same value. A long numeric array is
// kept as its length and digest, because 1,536 floats say nothing to a reader.
//
// src/test-support/e2e-artifact.test.ts lists the failures of this module
// that an end-to-end run cannot see.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'vitest';

/** Set to '1' to write the golden of every case that differs. */
export const ACCEPT_ARTIFACTS = 'AURACLE_E2E_ACCEPT';

/** Where the committed artifacts live. */
export const ARTIFACT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'artifacts');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// ISO 8601 takes a `T`, and Postgres text takes a space and may drop the
// zone minutes: `2026-09-26 15:49:20.12+00`.
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)/g;
/** A numeric array longer than this is kept as its length and digest. */
const MAX_INLINE_NUMBERS = 16;

/**
 * A value the caller knows varies between runs.
 *
 * It matches a whole string only, so registering the UID `3` leaves the
 * number 3 and the text "step 3" alone. A short value such as a UID must name
 * the `keys` it sits under. Without them the UID "1" also claims an epoch "1".
 */
export interface Volatile {
  readonly value: string;
  readonly kind: string;
  /** The property names the value may sit under. Absent means anywhere. */
  readonly keys?: readonly string[];
}

/**
 * Renders a value as stable JSON: sorted keys, two-space indent, a trailing
 * newline, and every volatile value replaced by its token.
 */
export function renderArtifact(value: unknown, volatile: readonly Volatile[] = []): string {
  const seen = new Map<string, Map<string, string>>();
  const token = (kind: string, raw: string): string => {
    let tokens = seen.get(kind);
    if (!tokens) seen.set(kind, (tokens = new Map()));
    let name = tokens.get(raw);
    if (!name) tokens.set(raw, (name = `<${kind}:${tokens.size + 1}>`));
    return name;
  };

  const registered = (node: string, key: string | undefined): Volatile | undefined =>
    volatile.find((v) => v.value === node && (v.keys === undefined || (key !== undefined && v.keys.includes(key))));

  // `key` is the property the node sits under. An array passes its own key on
  // to its elements, so a list of UIDs under `uids` still counts as `uids`.
  const walk = (node: unknown, key?: string): unknown => {
    if (typeof node === 'bigint') return node.toString();
    if (node instanceof Date) return '<time>';
    if (typeof node === 'string') {
      const match = registered(node, key);
      if (match !== undefined) return token(match.kind, node);
      return node.replace(UUID, (raw) => token('uuid', raw.toLowerCase())).replace(TIMESTAMP, '<time>');
    }
    if (Array.isArray(node)) {
      if (node.length > MAX_INLINE_NUMBERS && node.every((x) => typeof x === 'number')) {
        return { numbers: node.length, sha256: createHash('sha256').update(JSON.stringify(node)).digest('hex') };
      }
      return node.map((child) => walk(child, key));
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node).sort()) {
        const child = (node as Record<string, unknown>)[key];
        if (child !== undefined) out[key] = walk(child, key);
      }
      return out;
    }
    return node;
  };

  return JSON.stringify(walk(value), null, 2) + '\n';
}

export type Settlement = 'match' | 'accepted' | 'missing' | 'changed';

/**
 * Compares rendered text with the committed golden at `path`. Without
 * `accept`, it never writes the golden: a missing or different one leaves the
 * text beside it as `.actual.json`. A match clears that file.
 */
export function settleArtifact(path: string, text: string, accept: boolean): Settlement {
  const actual = path.replace(/\.json$/, '.actual.json');
  const exists = existsSync(path);
  if (exists && readFileSync(path, 'utf8') === text) {
    rmSync(actual, { force: true });
    return 'match';
  }
  mkdirSync(dirname(path), { recursive: true });
  if (accept) {
    writeFileSync(path, text);
    rmSync(actual, { force: true });
    return 'accepted';
  }
  writeFileSync(actual, text);
  return exists ? 'changed' : 'missing';
}

const claimed = new Map<string, string>();

/**
 * Reserves an artifact name for one case, so two cases never share a file.
 *
 * The suite part must be the calling file's own name, less `.db.test.ts`.
 * Each file runs in a worker of its own, so this map cannot see another
 * file; the rule makes a clash between files impossible instead. The same
 * case may claim its name again, because a retry builds its artifact anew.
 */
export function claimArtifactName(name: string, testPath: string, testName: string): void {
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(name)) {
    throw new Error(`artifact name '${name}' must be '<suite>/<case>' in lower-case letters, digits and dashes`);
  }
  const suite = basename(testPath).replace(/\.db\.test\.ts$|\.test\.ts$/, '');
  if (!name.startsWith(`${suite}/`)) {
    throw new Error(`artifact name '${name}' must start with '${suite}/', the name of the file that writes it`);
  }
  const owner = `${testPath}::${testName}`;
  const holder = claimed.get(name);
  if (holder !== undefined && holder !== owner) throw new Error(`two cases name the artifact '${name}'`);
  claimed.set(name, owner);
}

/** What a case states before it runs. */
export interface ArtifactInputs {
  /** The seed every generated input derives from, or null when none does. */
  readonly seed: number | null;
  readonly inputs: Record<string, unknown>;
}

/** The artifact one end-to-end case builds and settles at its end. */
export class E2eArtifact {
  private readonly observed: Record<string, unknown> = {};
  private readonly volatile: Volatile[] = [];

  /** `name` is `<suite>/<case>`, and it names the file under ARTIFACT_DIR. */
  constructor(
    readonly name: string,
    private readonly start: ArtifactInputs,
  ) {
    const state = expect.getState();
    claimArtifactName(name, state.testPath ?? '', state.currentTestName ?? '');
  }

  /**
   * Marks a value that varies between runs by design, such as a mailbox UID.
   * Name the `keys` it sits under whenever the value is short enough to
   * collide with an unrelated one.
   */
  vary(value: string, kind: string, keys?: readonly string[]): void {
    this.volatile.push(keys === undefined ? { value, kind } : { value, kind, keys });
  }

  /** Records one part of the observed end state. A key records once. */
  observe(key: string, value: unknown): void {
    if (key in this.observed) throw new Error(`artifact '${this.name}' already observed '${key}'`);
    this.observed[key] = value;
  }

  /** Renders the artifact and fails unless it matches the committed one. */
  finish(): void {
    const path = join(ARTIFACT_DIR, `${this.name}.json`);
    const text = renderArtifact(
      { artifact: this.name, seed: this.start.seed, inputs: this.start.inputs, observed: this.observed },
      this.volatile,
    );
    const outcome = settleArtifact(path, text, process.env[ACCEPT_ARTIFACTS] === '1');
    const actual = path.replace(/\.json$/, '.actual.json');
    if (outcome === 'missing') {
      throw new Error(
        `no committed artifact for '${this.name}'. This run wrote ${actual}. `
          + `Rerun with ${ACCEPT_ARTIFACTS}=1 to accept it, then review and commit ${path}.`,
      );
    }
    if (outcome === 'changed') {
      throw new Error(
        `artifact '${this.name}' differs from the committed one. Run diff ${path} ${actual}. `
          + `Rerun with ${ACCEPT_ARTIFACTS}=1 only if the change is intended.`,
      );
    }
  }
}
