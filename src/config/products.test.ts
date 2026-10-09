// The product catalogue and the channel map (DEC-47).
//
// DEC-47: "Each run records the product of the channel its message arrived
// on. A run retrieves the documents of its product and the documents that
// declare no product." The catalogue is the vocabulary: a channel names one
// of these products, and a document declares them.
//
// Read from `products.json` with the standard library's parser. This
// repository has no YAML parser and this change adds no runtime dependency,
// which is why the file is JSON.
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assertKnownProducts, loadProducts, parseProducts, productForChannel } from './products.js';

/** The file this repository ships, as a plain object. */
const SHIPPED = {
  products: [
    { id: 'aurora', label: 'Aurora' },
    { id: 'ledger', label: 'Ledger' },
  ],
  channels: { shipping: 'aurora', billing: 'ledger', 'Aurora Support': 'aurora' },
};

describe('the product catalogue', () => {
  it('reads the products and the channels that serve them', () => {
    const catalogue = parseProducts(SHIPPED);
    expect(catalogue.products.map((product) => product.id)).toEqual(['aurora', 'ledger']);
    expect(catalogue.products[0]?.label).toBe('Aurora');
    // A channel names one product, and the lookup is exact: a channel the
    // map does not name is null, never a guess.
    expect(productForChannel(catalogue, 'shipping')).toBe('aurora');
    expect(productForChannel(catalogue, 'Aurora Support')).toBe('aurora');
    expect(productForChannel(catalogue, 'billing')).toBe('ledger');
    expect(productForChannel(catalogue, 'returns')).toBeNull();
    // A ticket the source reported no channel for is null too, and it is not
    // the same fact as a channel nobody mapped — both are stated in words.
    expect(productForChannel(catalogue, null)).toBeNull();
  });

  // The refusals. A catalogue with no products is a deployment that mapped
  // nothing, and every one of these is a mistake the operator hears about at
  // startup rather than from a case with no product.
  it('refuses a catalogue that cannot be read as one', () => {
    const cases: Array<[string, unknown]> = [
      ['not an object', [1, 2]],
      ['no products', { products: [], channels: {} }],
      ['no channels', { products: [{ id: 'aurora', label: 'Aurora' }] }],
      ['product with no id', { products: [{ label: 'Aurora' }], channels: { a: 'aurora' } }],
      ['blank product id', { products: [{ id: '  ', label: 'Aurora' }], channels: { a: 'x' } }],
      ['product with no label', { products: [{ id: 'aurora' }], channels: { a: 'aurora' } }],
      [
        'duplicate product id',
        {
          products: [{ id: 'aurora', label: 'A' }, { id: 'aurora', label: 'B' }],
          channels: { a: 'aurora' },
        },
      ],
      [
        'channel mapped to a product nobody declares',
        { products: [{ id: 'aurora', label: 'A' }], channels: { a: 'nobody' } },
      ],
      ['blank channel name', { products: [{ id: 'aurora', label: 'A' }], channels: { ' ': 'aurora' } }],
      // The console writes `__none__` for a run with no product, so the
      // namespace is reserved and a real product cannot take that spelling.
      ['a reserved name', { products: [{ id: '__none__', label: 'A' }], channels: { a: '__none__' } }],
    ];
    for (const [why, raw] of cases) {
      expect(() => parseProducts(raw), why).toThrow();
    }
  });

  // The refusal names the reserved name, so an operator who wrote one hears
  // which value the console already uses.
  it('refuses a product name reserved for the console\'s own spelling', () => {
    expect(() => parseProducts({
      products: [{ id: '__none__', label: 'None' }],
      channels: { shipping: '__none__' },
    })).toThrow(/__none__.*reserved/s);
  });

  // A product no channel serves is a product nobody can receive a case for,
  // and a corpus scoped to it is dead weight. Refused, so the map says what
  // it means.
  it('refuses a product no channel serves', () => {
    expect(() => parseProducts({
      products: [{ id: 'aurora', label: 'Aurora' }, { id: 'ledger', label: 'Ledger' }],
      channels: { shipping: 'aurora' },
    })).toThrow(/ledger/);
  });

  // The document vocabulary. A document declaring a product the catalogue
  // does not hold would be retrieved by nobody, silently — the failure the
  // loader refuses by name.
  it('refuses a document naming a product the catalogue does not hold', () => {
    const catalogue = parseProducts(SHIPPED);
    expect(() => assertKnownProducts(catalogue, ['aurora'], 'DOC-1')).not.toThrow();
    expect(() => assertKnownProducts(catalogue, [], 'DOC-1')).not.toThrow();
    expect(() => assertKnownProducts(catalogue, ['aurora', 'ledger'], 'DOC-1')).not.toThrow();
    expect(() => assertKnownProducts(catalogue, ['nobody'], 'DOC-7'))
      .toThrow(/DOC-7.*nobody/);
    expect(() => assertKnownProducts(catalogue, ['aurora', 'nobody'], 'DOC-7'))
      .toThrow(/nobody/);
  });

  // The file this repository ships, read from disk: the shape above is not a
  // fixture invented for this test.
  it('reads the products.json this repository ships', () => {
    // fileURLToPath, not `.pathname`, which percent-encodes the path.
    const catalogue = loadProducts(fileURLToPath(new URL('../../products.json', import.meta.url)));
    expect(catalogue.products.length).toBeGreaterThanOrEqual(2);
    for (const product of catalogue.products) {
      expect(product.id.trim()).toBe(product.id);
      expect(product.label.trim().length).toBeGreaterThan(0);
    }
    // Every product the file declares is served by at least one channel, and
    // every channel names a product in the file.
    const served = new Set(catalogue.channels.values());
    for (const product of catalogue.products) expect(served.has(product.id)).toBe(true);
  });

  it('names the file it could not read', () => {
    expect(() => loadProducts('/nonexistent/products.json')).toThrow(/products\.json/);
  });
});
