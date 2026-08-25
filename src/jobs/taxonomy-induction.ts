// Taxonomy induction — docs/v1-architecture.md section 4.11, DEC-02, DEC-10.
//
// Offline job. It is not part of the runtime path. It reads raw ticket
// history that has no tags (DEC-02), embeds it, clusters it, and asks a
// model to name each cluster. A person curates the result to the intent cap
// (DEC-10). The system never consumes this artifact at runtime; the curated
// taxonomy feeds the classifier as an input.
//
// Section 4.11: make embeddings, make clusters, let a model give a name to
// each cluster, keep an 'other' group, cap named intents so the curated
// taxonomy fits the 25-intent limit from paragraph 3.3. The committed
// fixtures/taxonomy.json holds 24 named intents plus 'other' under one
// 25-entry cap, so this job emits at most INTENT_CAP - 1 named candidates
// plus the 'other' group.

import type { ModelProvider } from '../models/provider.js';

export { INTENT_CAP } from '../fixtures/load.js';

/** One ticket of untagged history (DEC-02). */
export interface HistoryItem {
  id: string;
  text: string;
}

export interface InductionInput {
  items: readonly HistoryItem[];
  /** DEC-26: pinned prompt version for both the embed and naming calls. */
  promptVer: string;
  /** Pinned chat model id used to name clusters (DEC-26). */
  chatModelVer: string;
  /** Pinned embedding model id (DEC-26). */
  embedModelVer: string;
  /** Cluster count upper bound before folding and capping. */
  maxClusters?: number;
  /** Clusters smaller than this fold into 'other'. Default 5. */
  minClusterSize?: number;
  /** Seed for the deterministic k-means init. Default 42. */
  seed?: number;
}

/** One named candidate for the person to curate. */
export interface TaxonomyCandidate {
  id: string;
  label: string;
  size: number;
  sample_item_ids: string[];
}

/** The candidate taxonomy artifact a person curates (section 4.11 step 4). */
export interface CandidateTaxonomy {
  version: 1;
  source: string;
  prompt_ver: string;
  chat_model_ver: string;
  embed_model_ver: string;
  item_count: number;
  cost_cents: number;
  candidates: TaxonomyCandidate[];
  other: {
    size: number;
    sample_item_ids: string[];
  };
}

const NAMING_TEMPERATURE = 0.2;
const SAMPLES_PER_CLUSTER = 8;
const TEXT_SNIPPET_CHARS = 300;
const MAX_KMEANS_ITERATIONS = 100;

/**
 * Cluster unit-length vectors with k-means. Deterministic for a given seed:
 * k-means++ init draws through a seeded PRNG, not Math.random.
 * Returns one cluster index per input vector.
 */
export function kMeans(
  vectors: readonly number[][],
  k: number,
  seed: number,
): number[] {
  const n = vectors.length;
  if (n === 0) throw new Error('kMeans received no vectors');
  const clusters = Math.min(Math.max(1, Math.floor(k)), n);

  const points = vectors.map(l2Normalize);
  const rand = mulberry32(seed);
  let assignments = assign(points, kMeansPlusPlusInit(points, clusters, rand));

  for (let i = 0; i < MAX_KMEANS_ITERATIONS; i++) {
    const centroids = recomputeCentroids(points, assignments, clusters);
    const next = assign(points, centroids);
    if (sameAssignments(assignments, next)) break;
    assignments = next;
  }
  return assignments;
}

/**
 * Fold small clusters into 'other', then enforce the named-intent cap.
 *
 * The cap is INTENT_CAP - 1: after human curation the final taxonomy holds
 * the surviving names plus the mandatory 'other' entry within the
 * 25-intent limit (section 4.11, paragraph 3.3). Survivors rank by size,
 * largest first; ties resolve by smallest member index.
 */
export function capClusters(
  assignments: readonly number[],
  maxNamedIntents: number,
  minClusterSize: number,
): { kept: number[]; foldedIntoOther: number[] } {
  const sizes = new Map<number, { size: number; firstMember: number }>();
  for (let i = 0; i < assignments.length; i++) {
    const c = assignments[i]!;
    const entry = sizes.get(c);
    if (entry) {
      entry.size += 1;
    } else {
      sizes.set(c, { size: 1, firstMember: i });
    }
  }

  const ranked = [...sizes.entries()]
    .sort(
      ([a, ea], [b, eb]) =>
        eb.size - ea.size || ea.firstMember - eb.firstMember || a - b,
    )
    .map(([c]) => c);

  const kept: number[] = [];
  const foldedIntoOther: number[] = [];
  for (const c of ranked) {
    const entry = sizes.get(c)!;
    if (entry.size < minClusterSize) {
      foldedIntoOther.push(c);
    } else if (kept.length < maxNamedIntents) {
      kept.push(c);
    } else {
      foldedIntoOther.push(c);
    }
  }
  return { kept, foldedIntoOther };
}

/** Lowercase slug intent id from a model-supplied label. */
export function slugifyIntentId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'intent';
}

/** Run the full section 4.11 pipeline against a model provider. */
export async function induceTaxonomy(
  provider: ModelProvider,
  input: InductionInput,
): Promise<CandidateTaxonomy> {
  if (input.items.length === 0) {
    throw new Error('taxonomy induction received no history items');
  }

  // Step 1. Embeddings for the history.
  const embedded = await provider.embed({
    input: input.items.map((item) => item.text),
    promptVer: input.promptVer,
    modelVer: input.embedModelVer,
  });
  if (embedded.vectors.length !== input.items.length) {
    throw new Error(
      `embedder returned ${embedded.vectors.length} vectors for ${input.items.length} items`,
    );
  }

  // Step 2. Clusters.
  const maxClusters = input.maxClusters ?? INTENT_CAP_DEFAULT_MINUS_ONE;
  const minClusterSize = input.minClusterSize ?? 5;
  const assignments = kMeans(
    embedded.vectors,
    maxClusters,
    input.seed ?? DEFAULT_SEED,
  );
  const { kept, foldedIntoOther } = capClusters(
    assignments,
    INTENT_CAP_DEFAULT_MINUS_ONE,
    minClusterSize,
  );

  const membersOf = (cluster: number): number[] => {
    const members: number[] = [];
    for (let i = 0; i < assignments.length; i++) {
      if (assignments[i] === cluster) members.push(i);
    }
    return members;
  };
  const idsOf = (indices: readonly number[]): string[] =>
    indices.map((i) => input.items[i]!.id);

  // Steps 3 and 4. Name each surviving cluster; a person curates later.
  const candidates: TaxonomyCandidate[] = [];
  const usedIds = new Set<string>(['other']);
  let costCents = embedded.costCents;

  for (const cluster of kept) {
    const members = membersOf(cluster);
    const representatives = pickRepresentatives(members, embedded.vectors);
    const named = await provider.complete({
      messages: buildNamingPrompt(members.length, input.items, representatives),
      temperature: NAMING_TEMPERATURE,
      maxOutputTokens: 32,
      promptVer: input.promptVer,
      modelVer: input.chatModelVer,
    });
    costCents += named.costCents;

    const label = named.text.trim().replace(/\s+/g, ' ');
    candidates.push({
      id: uniqueIntentId(slugifyIntentId(label), usedIds),
      label,
      size: members.length,
      sample_item_ids: idsOf(representatives),
    });
  }

  // Step 5. Keep the 'other' group and examine it.
  const otherIndices = foldedIntoOther.flatMap(membersOf);

  return {
    version: 1,
    source: 'synthetic',
    prompt_ver: input.promptVer,
    chat_model_ver: input.chatModelVer,
    embed_model_ver: input.embedModelVer,
    item_count: input.items.length,
    cost_cents: costCents,
    candidates,
    other: {
      size: otherIndices.length,
      sample_item_ids: idsOf(otherIndices.slice(0, SAMPLES_PER_CLUSTER)),
    },
  };
}

const INTENT_CAP_DEFAULT_MINUS_ONE = 24;
const DEFAULT_SEED = 42;

function buildNamingPrompt(
  clusterSize: number,
  items: readonly HistoryItem[],
  representativeIndices: readonly number[],
): { role: 'system' | 'user'; content: string }[] {
  const examples = representativeIndices
    .map((i) => {
      const text =
        items[i]!.text.length > TEXT_SNIPPET_CHARS
          ? `${items[i]!.text.slice(0, TEXT_SNIPPET_CHARS)}...`
          : items[i]!.text;
      return `- ${text.replace(/\s+/g, ' ')}`;
    })
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'You name clusters of support tickets. Reply with one short intent label of at most five words. Reply with the label only.',
    },
    {
      role: 'user',
      content: `This cluster holds ${clusterSize} support tickets. Its closest examples:\n${examples}`,
    },
  ];
}

/** Members closest to the centroid first, capped at SAMPLES_PER_CLUSTER. */
function pickRepresentatives(
  memberIndices: readonly number[],
  vectors: readonly number[][],
): number[] {
  const normalized = vectors.map(l2Normalize);
  const centroid = new Array<number>(normalized[0]!.length).fill(0);
  for (const i of memberIndices) {
    const point = normalized[i]!;
    for (let d = 0; d < centroid.length; d++) {
      centroid[d] = (centroid[d] ?? 0) + point[d]!;
    }
  }
  for (let d = 0; d < centroid.length; d++) {
    centroid[d] = (centroid[d] ?? 0) / memberIndices.length;
  }
  return [...memberIndices]
    .sort(
      (a, b) =>
        sqDistance(normalized[a]!, centroid) -
        sqDistance(normalized[b]!, centroid),
    )
    .slice(0, SAMPLES_PER_CLUSTER);
}

function uniqueIntentId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

// --- deterministic k-means helpers -------------------------------------

function l2Normalize(vector: readonly number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) return vector.map(() => 0);
  return vector.map((x) => x / norm);
}

function sqDistance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return sum;
}

/** Seeded PRNG (mulberry32). Same seed, same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function kMeansPlusPlusInit(
  points: readonly number[][],
  k: number,
  rand: () => number,
): number[][] {
  const centers: number[][] = [ [...points[Math.floor(rand() * points.length)]!] ];
  const nearest = points.map((p) => sqDistance(p, centers[0]!));
  while (centers.length < k) {
    const total = nearest.reduce((sum, d) => sum + d, 0);
    let nextIndex = -1;
    if (total > 0) {
      let threshold = rand() * total;
      for (let i = 0; i < points.length; i++) {
        threshold -= nearest[i]!;
        if (threshold <= 0) {
          nextIndex = i;
          break;
        }
      }
      if (nextIndex < 0) nextIndex = points.length - 1;
    } else {
      // All remaining points sit on chosen centers; any point works.
      nextIndex = Math.floor(rand() * points.length);
    }
    const center = [...points[nextIndex]!];
    centers.push(center);
    for (let i = 0; i < points.length; i++) {
      const d = sqDistance(points[i]!, center);
      if (d < nearest[i]!) nearest[i] = d;
    }
  }
  return centers;
}

function assign(
  points: readonly number[][],
  centers: readonly number[][],
): number[] {
  return points.map((p) => {
    let best = 0;
    let bestDist = sqDistance(p, centers[0]!);
    for (let c = 1; c < centers.length; c++) {
      const d = sqDistance(p, centers[c]!);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    return best;
  });
}

function recomputeCentroids(
  points: readonly number[][],
  assignments: readonly number[],
  k: number,
): number[][] {
  const dims = points[0]!.length;
  const sums = Array.from({ length: k }, () => new Array<number>(dims).fill(0));
  const counts = new Array<number>(k).fill(0);
  for (let i = 0; i < points.length; i++) {
    const c = assignments[i]!;
    counts[c] = (counts[c] ?? 0) + 1;
    const point = points[i]!;
    const sum = sums[c]!;
    for (let d = 0; d < dims; d++) sum[d] = (sum[d] ?? 0) + point[d]!;
  }
  return sums.map((sum, c) =>
    counts[c] === 0 ? sum : sum.map((x) => x / counts[c]!),
  );
}

function sameAssignments(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
