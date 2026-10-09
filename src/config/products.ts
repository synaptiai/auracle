/**
 * The product catalogue and the channel map (DEC-47).
 *
 * DEC-47: "Each run records the product of the channel its message arrived
 * on. A run retrieves the documents of its product and the documents that
 * declare no product." This module is the vocabulary those sentences name:
 * the products a deployment serves, and which channel serves each.
 *
 * A file rather than ledger rows, and JSON rather than YAML. The mapping is
 * deployment configuration — the same shape `bands.yaml` has at this
 * repository's root — and this repository has no YAML parser, so reading it
 * with the standard library's is what keeps the runtime dependency list at
 * three. The path is the caller's; `PRODUCTS_FILE` names it in the processes.
 *
 * Every refusal here happens once, at startup. A catalogue with no products,
 * a channel mapped to a product nobody declares, and a product no channel
 * serves are all mistakes an operator makes in one file, and each has a
 * different fix. The alternative is enqueuing tickets whose product nothing
 * retrieves, which surfaces as an empty answer rather than as this fault.
 */
import { readFileSync } from 'node:fs';

/** One product a deployment serves. */
export interface Product {
  readonly id: string;
  readonly label: string;
}

/** The products, and the channel that serves each. */
export interface ProductCatalogue {
  readonly products: readonly Product[];
  /** Channel name, exactly as the source reports it, to a product id. */
  readonly channels: ReadonlyMap<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a parsed `products.json` into a catalogue, or refuses it by name.
 *
 * The refusals are the file's own mistakes, so each message says which value
 * is wrong: an operator edits one file, and a message that named only the
 * shape would send them looking through it.
 */
export function parseProducts(raw: unknown): ProductCatalogue {
  if (!isRecord(raw)) throw new Error('must hold an object');
  const declared = raw['products'];
  const mapped = raw['channels'];
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error('must declare at least one product');
  }
  if (!isRecord(mapped) || Object.keys(mapped).length === 0) {
    throw new Error('must map at least one channel to a product');
  }

  const products: Product[] = [];
  const ids = new Set<string>();
  for (const entry of declared) {
    if (!isRecord(entry)) throw new Error('holds a product that is not an object');
    const id = entry['id'];
    const label = entry['label'];
    if (typeof id !== 'string' || id.trim() !== id || id === '') {
      throw new Error(`holds a product with no id: ${JSON.stringify(entry)}`);
    }
    // A name wrapped in double underscores is this repository's own, not a
    // product. The console writes `__none__` for a run whose channel mapped
    // to no product, and a catalogue that declared it would put a real
    // product in the same chip as that population.
    if (/^__.*__$/.test(id)) {
      throw new Error(
        `declares the product '${id}', and a name wrapped in double underscores is`
          + ' reserved for this repository\'s own spellings',
      );
    }
    if (typeof label !== 'string' || label.trim() === '') {
      throw new Error(`declares the product '${id}' with no label`);
    }
    if (ids.has(id)) throw new Error(`declares the product '${id}' twice`);
    ids.add(id);
    products.push({ id, label });
  }

  const channels = new Map<string, string>();
  for (const [channel, product] of Object.entries(mapped)) {
    if (channel.trim() !== channel || channel === '') {
      throw new Error(`maps a channel with a blank name: ${JSON.stringify(channel)}`);
    }
    if (typeof product !== 'string' || !ids.has(product)) {
      throw new Error(`maps the channel '${channel}' to '${String(product)}', which is not a product`);
    }
    channels.set(channel, product);
  }

  // A product no channel serves cannot receive a case, so nothing retrieves
  // its documents. Named here, because a corpus scoped to it looks healthy.
  const served = new Set(channels.values());
  for (const product of products) {
    if (!served.has(product.id)) {
      throw new Error(`declares the product '${product.id}', which no channel serves`);
    }
  }

  return { products, channels };
}

/**
 * The catalogue file a process reads when `PRODUCTS_FILE` names none.
 *
 * Relative, so a process run from a checkout reads the file in it, and the
 * image puts the file at its working directory.
 */
export const DEFAULT_PRODUCTS_FILE = 'products.json';

/**
 * Reads the catalogue the processes share: `PRODUCTS_FILE`, or the file this
 * repository ships.
 *
 * Each entry point calls this once at startup and hands the result to what
 * needs it, so the file is read once per process and a fault refuses the
 * process rather than every message that arrives afterwards. A daemon that
 * read it per message would answer the first delivery and then fail the
 * catalogues the operator is editing.
 */
export function productCatalogueFromEnv(): ProductCatalogue {
  // An empty value is an absence, as `console/src/hold-lapse.ts` and its
  // siblings read their own variables: `PRODUCTS_FILE=` is what an
  // unsubstituted template leaves behind, and passing it through would
  // refuse every process with a sentence naming neither the variable nor
  // the environment.
  const named = process.env['PRODUCTS_FILE'];
  return loadProducts(named === undefined || named === '' ? DEFAULT_PRODUCTS_FILE : named);
}

/** Reads and parses the catalogue file. The one read this module makes. */
export function loadProducts(path: string): ProductCatalogue {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`the product catalogue '${path}' could not be read: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`the product catalogue '${path}' is not JSON: ${(error as Error).message}`);
  }
  try {
    return parseProducts(raw);
  } catch (error) {
    // Each refusal above is a clause, so it follows the prefix as a sentence.
    throw new Error(`the product catalogue '${path}' ${(error as Error).message}`);
  }
}

/**
 * The product a channel serves, or null.
 *
 * Null is one answer for two facts: the source reported no channel, and the
 * channel is one the map does not name. Both mean no product is mapped, and
 * every surface says so in words — DEC-47's "never a blank that reads as
 * zero" is why this returns null rather than an empty string.
 */
export function productForChannel(
  catalogue: ProductCatalogue,
  channel: string | null,
): string | null {
  if (channel === null) return null;
  return catalogue.channels.get(channel) ?? null;
}

/**
 * Refuses a document that declares a product the catalogue does not hold.
 *
 * Such a document is retrieved by nobody: the filter keeps a run's product's
 * documents and the unscoped ones, so a third product's documents are read
 * only by a run that product is never recorded for. The fault is silent at
 * read time, so it is refused at load time, naming both.
 */
export function assertKnownProducts(
  catalogue: ProductCatalogue,
  products: readonly string[],
  docId: string,
): void {
  const known = new Set(catalogue.products.map((product) => product.id));
  for (const product of products) {
    if (!known.has(product)) {
      throw new Error(
        `the document '${docId}' declares the product '${product}', which the catalogue does not hold`,
      );
    }
  }
}
