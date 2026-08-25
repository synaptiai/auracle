// Tests for the taxonomy-induction job (section 4.11, DEC-02, DEC-10).
// The model is a FakeProvider: one embed step for the corpus, then one chat
// step per surviving cluster. No network, no real model.

import { describe, expect, it } from 'vitest';

import {
  INTENT_CAP,
  capClusters,
  induceTaxonomy,
  kMeans,
  slugifyIntentId,
} from './taxonomy-induction.js';
import type { HistoryItem, InductionInput } from './taxonomy-induction.js';
import { FakeProvider } from '../models/fake.js';
import type { RecordedCall } from '../models/fake.js';

const PIN = {
  promptVer: 'induce-t1',
  chatModelVer: 'test-chat',
  embedModelVer: 'test-embed',
};

const ITEMS: HistoryItem[] = [
  { id: 'SYN-1', text: 'I want a refund for order A' },
  { id: 'SYN-2', text: 'Please refund my last payment' },
  { id: 'SYN-3', text: 'Money back for the broken order' },
  { id: 'SYN-4', text: 'I cannot log into my account' },
  { id: 'SYN-5', text: 'Login fails with my password' },
  { id: 'SYN-6', text: 'Something else entirely' },
];

/** Two dense groups plus one far outlier. */
const VECTORS = [
  [1.0, 0.0],
  [1.02, -0.01],
  [0.98, 0.03],
  [-1.0, 0.1],
  [-1.02, 0.08],
  [0.5, -0.87],
];

function input(overrides: Partial<InductionInput> = {}): InductionInput {
  return { items: ITEMS, ...PIN, ...overrides };
}

function scriptedProvider(names: string[]): FakeProvider {
  return new FakeProvider([
    { vectors: VECTORS },
    ...names.map((text) => ({ text })),
  ]);
}

function chatCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.kind === 'chat');
}

describe('kMeans', () => {
  it('separates two obvious groups', () => {
    const vectors = [
      [10, 0],
      [9.5, 0.5],
      [0, 10],
      [0.5, 9.5],
    ];
    const assignments = kMeans(vectors, 2, 42);
    expect(assignments[0]).toBe(assignments[1]);
    expect(assignments[2]).toBe(assignments[3]);
    expect(assignments[0]).not.toBe(assignments[2]);
  });

  it('is deterministic for a given seed', () => {
    const vectors = VECTORS.concat([[5, 5]]);
    const a = kMeans(vectors, 3, 7);
    const b = kMeans(vectors, 3, 7);
    expect(a).toEqual(b);
  });

  it('clamps k to the point count', () => {
    const assignments = kMeans([[1, 0]], 25, 42);
    expect(assignments).toEqual([0]);
  });

  it('throws on empty input', () => {
    expect(() => kMeans([], 3, 42)).toThrow(/no vectors/);
  });
});

describe('capClusters (section 4.11 intent cap)', () => {
  it('folds clusters below the minimum size into other', () => {
    // Clusters of sizes 4, 2, 1 at minClusterSize 2: the singleton folds.
    const assignments = [0, 0, 0, 0, 1, 1, 2];
    const { kept, foldedIntoOther } = capClusters(assignments, 24, 2);
    expect(kept).toEqual([0, 1]);
    expect(foldedIntoOther).toEqual([2]);
  });

  it('keeps the largest clusters when more survive than the named cap', () => {
    // 30 single-item clusters; only the first 24 by rank stay named.
    const assignments = Array.from({ length: 30 }, (_, i) => i);
    const { kept, foldedIntoOther } = capClusters(assignments, INTENT_CAP - 1, 1);
    expect(kept).toHaveLength(INTENT_CAP - 1);
    expect(foldedIntoOther).toHaveLength(30 - (INTENT_CAP - 1));
    expect(Math.max(...kept)).toBeLessThan(INTENT_CAP - 1);
  });
});

describe('slugifyIntentId', () => {
  it('turns a label into a slug id', () => {
    expect(slugifyIntentId('Refund request')).toBe('refund-request');
  });

  it('strips punctuation and collapses separators', () => {
    expect(slugifyIntentId('  Can’t Log In! ')).toBe('can-t-log-in');
  });

  it('falls back when the label has no usable characters', () => {
    expect(slugifyIntentId('???')).toBe('intent');
  });
});

describe('induceTaxonomy (section 4.11 pipeline, fake model)', () => {
  it('embeds once, names each kept cluster, emits the candidate artifact', async () => {
    // maxClusters 3 puts the outlier in its own cluster; minClusterSize 2
    // folds that singleton cluster into 'other'.
    const provider = scriptedProvider(['Refund request', 'Login trouble']);

    const result = await induceTaxonomy(provider, input({ maxClusters: 3, minClusterSize: 2 }));

    // One embed call carrying the whole history (DEC-02: untagged text).
    const embedCalls = provider.calls.filter((c) => c.kind === 'embed');
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]?.input).toEqual(ITEMS.map((i) => i.text));
    expect(embedCalls[0]?.modelVer).toBe(PIN.embedModelVer);

    // One naming call per surviving cluster, at the pinned chat versions.
    const chats = chatCalls(provider.calls);
    expect(chats).toHaveLength(2);
    for (const call of chats) {
      expect(call.modelVer).toBe(PIN.chatModelVer);
      expect(call.promptVer).toBe(PIN.promptVer);
    }

    // Largest cluster first: SYN-1..3 form the dense refund group.
    expect(result.candidates[0]?.id).toBe('refund-request');
    expect(result.candidates[0]?.label).toBe('Refund request');
    expect(result.candidates[0]?.size).toBe(3);
    expect(result.candidates[0]?.sample_item_ids).toContain('SYN-1');

    expect(result.candidates[1]?.id).toBe('login-trouble');
    expect(result.candidates[1]?.size).toBe(2);

    // Step 5: the 'other' group survives for examination.
    expect(result.other.size).toBe(1);
    expect(result.other.sample_item_ids).toEqual(['SYN-6']);
  });

  it('sends cluster examples to the naming prompt', async () => {
    const provider = scriptedProvider(['Refund request', 'Login trouble']);

    await induceTaxonomy(provider, input({ maxClusters: 3, minClusterSize: 2 }));

    const firstPrompt = chatCalls(provider.calls)[0]?.messages?.at(-1)?.content ?? '';
    expect(firstPrompt).toMatch(/cluster holds \d+ support tickets/);
    expect(firstPrompt).toContain('refund');
  });

  it('records pinned versions, counts, cost and synthetic source in the artifact', async () => {
    const provider = new FakeProvider([
      { vectors: VECTORS, costCents: 3 },
      { text: 'Refund request', costCents: 7 },
      { text: 'Login trouble', costCents: 7 },
    ]);

    const result = await induceTaxonomy(provider, input({ maxClusters: 3, minClusterSize: 2 }));

    expect(result.version).toBe(1);
    expect(result.source).toBe('synthetic');
    expect(result.prompt_ver).toBe(PIN.promptVer);
    expect(result.chat_model_ver).toBe(PIN.chatModelVer);
    expect(result.embed_model_ver).toBe(PIN.embedModelVer);
    expect(result.item_count).toBe(ITEMS.length);
    expect(result.cost_cents).toBe(17);
  });

  it('dedupes ids when two clusters receive the same name', async () => {
    const provider = scriptedProvider(['Refund request', 'Refund Request']);

    const result = await induceTaxonomy(provider, input({ maxClusters: 3, minClusterSize: 2 }));

    const ids = result.candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('refund-request');
    expect(ids).toContain('refund-request-2');
  });

  it('enforces the named-intent cap so the curated taxonomy fits 25 entries', async () => {
    // 26 well-separated unit-vector groups: even if every cluster survives
    // folding, at most INTENT_CAP - 1 get named and the rest join 'other'.
    const groupCount = 30;
    const perGroup = 6;
    const items: HistoryItem[] = [];
    const vectors: number[][] = [];
    for (let g = 0; g < groupCount; g++) {
      const direction = Array.from({ length: groupCount }, (_, d) =>
        d === g ? 1 : 0,
      );
      for (let m = 0; m < perGroup; m++) {
        items.push({ id: `SYN-${g}-${m}`, text: `ticket ${g} ${m}` });
        vectors.push(direction.map((x) => x + m * 0.001));
      }
    }
    const provider = new FakeProvider([
      { vectors },
      ...Array.from({ length: INTENT_CAP - 1 }, (_, i) => ({ text: `Group ${i}` })),
    ]);

    const result = await induceTaxonomy(
      provider,
      input({ items, maxClusters: groupCount, minClusterSize: 1 }),
    );

    expect(result.candidates.length).toBeLessThanOrEqual(INTENT_CAP - 1);
    expect(result.candidates.length + 1).toBeLessThanOrEqual(INTENT_CAP);
    const totalAccounted =
      result.candidates.reduce((sum, c) => sum + c.size, 0) + result.other.size;
    expect(totalAccounted).toBe(items.length);
    expect(result.other.size).toBeGreaterThan(0);
  });

  it('is deterministic across runs with the same script and seed', async () => {
    const run = () =>
      induceTaxonomy(scriptedProvider(['Refund request', 'Login trouble']), input({
        maxClusters: 3,
        minClusterSize: 2,
        seed: 11,
      }));
    const a = await run();
    const b = await run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('rejects an empty history before any model call', async () => {
    const provider = new FakeProvider();
    await expect(induceTaxonomy(provider, input({ items: [] }))).rejects.toThrow(
      /no history items/,
    );
    expect(provider.calls).toHaveLength(0);
  });

  it('throws when the embedder returns the wrong vector count', async () => {
    const provider = new FakeProvider([{ vectors: [[1, 0]] }]);
    await expect(induceTaxonomy(provider, input())).rejects.toThrow(
      /vectors for 6 items/,
    );
  });
});
