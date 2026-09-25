// One construction of the model provider (issue #72).
//
// The provider keeps its config private, so these assert the behaviour an
// adopter actually observes: which host the call goes to, what the
// Authorization header carries, and whether DEC-17's zero-retention flag is
// on the request body.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { embeddingPriceFromEnv, openRouterFromEnv } from './from-env.js';

const TOUCHED = ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'AURACLE_ZDR_ONLY', 'EMBEDDINGS_USD_PER_MTOK'] as const;
const saved = new Map<string, string | undefined>();
for (const name of TOUCHED) saved.set(name, process.env[name]);

// The shell's own price would change what an embedding answer costs here.
beforeEach(() => {
  delete process.env['EMBEDDINGS_USD_PER_MTOK'];
});

afterEach(() => {
  for (const name of TOUCHED) {
    const original = saved.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

/** Records the one request the provider makes and answers it plausibly. */
function recordingFetch(): { calls: { url: string; init: RequestInit }[]; impl: typeof fetch } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'an answer' } }],
        // `cost` is not optional: DEC-25 makes the provider refuse a
        // response that reports no cost rather than record a zero.
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.0001 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { calls, impl };
}

async function callOnce(provider: ReturnType<typeof openRouterFromEnv>): Promise<void> {
  await provider.complete({
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0,
    modelVer: 'a/model',
    promptVer: 'a-prompt',
  });
}

describe('openRouterFromEnv', () => {
  it('refuses when the key is absent', () => {
    delete process.env['OPENROUTER_API_KEY'];
    expect(() => openRouterFromEnv()).toThrow('OPENROUTER_API_KEY is not set.');
  });

  it('refuses when the key is empty', () => {
    process.env['OPENROUTER_API_KEY'] = '';
    expect(() => openRouterFromEnv()).toThrow('OPENROUTER_API_KEY is not set.');
  });

  it('refuses when the key is whitespace', () => {
    process.env['OPENROUTER_API_KEY'] = '   ';
    expect(() => openRouterFromEnv()).toThrow('OPENROUTER_API_KEY is not set.');
  });

  it('sends the key from the environment', async () => {
    process.env['OPENROUTER_API_KEY'] = 'a-test-key';
    delete process.env['OPENROUTER_BASE_URL'];
    const fetcher = recordingFetch();
    await callOnce(openRouterFromEnv({ fetchImpl: fetcher.impl }));
    const headers = fetcher.calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer a-test-key');
  });

  // fetch trims the header it sends, so a gateway echoes the trimmed key,
  // and the error scrub must look for the key in that form.
  it('sends the key without the whitespace a secret file leaves', async () => {
    process.env['OPENROUTER_API_KEY'] = 'a-test-key\n';
    delete process.env['OPENROUTER_BASE_URL'];
    const fetcher = recordingFetch();
    await callOnce(openRouterFromEnv({ fetchImpl: fetcher.impl }));
    const headers = fetcher.calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer a-test-key');
  });

  // fetch cannot send a key with a control character inside it, and its
  // refusal quotes the header whole. Refused at startup, without the key.
  it('refuses a key with a control character inside it', () => {
    for (const key of ['sk-synthetic-0000\nexport OTHER=1', 'sk-synthetic\r\n0000', 'sk-synthetic\t0000']) {
      process.env['OPENROUTER_API_KEY'] = key;
      let message = '';
      try {
        openRouterFromEnv();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(key)).toBe(
        'OPENROUTER_API_KEY holds a control character, such as a line break inside it. Set it to the key alone.',
      );
    }
  });

  // fetch refuses such a URL with an error that quotes it whole, password
  // included, and that error would reach the ledger and the log.
  it('refuses a base URL that carries credentials', () => {
    process.env['OPENROUTER_API_KEY'] = 'a-test-key';
    for (const url of ['https://user:secret@gateway.example.test/v1', 'https://user@gateway.example.test/v1']) {
      process.env['OPENROUTER_BASE_URL'] = url;
      expect(() => openRouterFromEnv(), url).toThrow(
        'OPENROUTER_BASE_URL carries credentials. Remove them from the URL: the provider sends OPENROUTER_API_KEY in a header.',
      );
    }
    process.env['OPENROUTER_BASE_URL'] = 'not a url';
    expect(() => openRouterFromEnv()).toThrow('OPENROUTER_BASE_URL is not a URL.');
  });

  // Every process that embeds reads the price here, after the key check.
  it('applies EMBEDDINGS_USD_PER_MTOK, and checks the key first', async () => {
    process.env['OPENROUTER_API_KEY'] = 'a-test-key';
    delete process.env['OPENROUTER_BASE_URL'];
    process.env['EMBEDDINGS_USD_PER_MTOK'] = '0.02';
    const noCost = (async () =>
      new Response(
        JSON.stringify({ data: [{ embedding: [0.1] }], usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;
    const result = await openRouterFromEnv({ fetchImpl: noCost })
      .embed({ input: ['a document'], modelVer: 'a/embed', promptVer: 'a-prompt' });
    // One million tokens at 0.02 USD per million is 20,000 micro-dollars.
    expect(result.costMicros).toBe(20_000);

    delete process.env['OPENROUTER_API_KEY'];
    process.env['EMBEDDINGS_USD_PER_MTOK'] = 'cheap';
    expect(() => openRouterFromEnv()).toThrow('OPENROUTER_API_KEY is not set.');
  });

  it('goes to openrouter.ai when no base URL is set', async () => {
    process.env['OPENROUTER_API_KEY'] = 'a-test-key';
    delete process.env['OPENROUTER_BASE_URL'];
    const fetcher = recordingFetch();
    await callOnce(openRouterFromEnv({ fetchImpl: fetcher.impl }));
    expect(fetcher.calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('honours OPENROUTER_BASE_URL', async () => {
    // The bug this module removes. Four of the six construction sites
    // ignored this variable, so an adopter who pointed the system at their
    // own gateway had four jobs quietly bypass it — carrying the adopter's
    // key straight to openrouter.ai, past whatever the gateway enforced.
    process.env['OPENROUTER_API_KEY'] = 'a-test-key';
    process.env['OPENROUTER_BASE_URL'] = 'https://gateway.example.test/v1';
    const fetcher = recordingFetch();
    await callOnce(openRouterFromEnv({ fetchImpl: fetcher.impl }));
    expect(fetcher.calls[0]?.url).toBe('https://gateway.example.test/v1/chat/completions');
  });

  it('ignores an empty base URL rather than sending the call to a bare path', async () => {
    // `OPENROUTER_BASE_URL=` would otherwise make the request URL
    // '/chat/completions', which fetch rejects as a relative URL.
    process.env['OPENROUTER_API_KEY'] = 'a-test-key';
    process.env['OPENROUTER_BASE_URL'] = '';
    const fetcher = recordingFetch();
    await callOnce(openRouterFromEnv({ fetchImpl: fetcher.impl }));
    expect(fetcher.calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('leaves the DEC-17 guarantee off when AURACLE_ZDR_ONLY is unset', async () => {
    process.env['OPENROUTER_API_KEY'] = 'a-test-key';
    delete process.env['AURACLE_ZDR_ONLY'];
    const fetcher = recordingFetch();
    await callOnce(openRouterFromEnv({ fetchImpl: fetcher.impl }));
    const body = JSON.parse(String(fetcher.calls[0]?.init.body)) as {
      provider?: { zdr?: boolean };
    };
    expect(body.provider?.zdr).not.toBe(true);
  });

  it('applies the DEC-17 guarantee when AURACLE_ZDR_ONLY is 1', async () => {
    process.env['OPENROUTER_API_KEY'] = 'a-test-key';
    process.env['AURACLE_ZDR_ONLY'] = '1';
    const fetcher = recordingFetch();
    await callOnce(openRouterFromEnv({ fetchImpl: fetcher.impl }));
    const body = JSON.parse(String(fetcher.calls[0]?.init.body)) as {
      provider?: { zdr?: boolean };
    };
    expect(body.provider?.zdr).toBe(true);
  });

  it('takes a caller override the environment cannot supply', async () => {
    // `load-docs` resolves the embedding price from EMBEDDINGS_USD_PER_MTOK
    // against a table of its own, and DEC-25 accounting needs the result:
    // without the price the provider refuses rather than reporting zero. The
    // cost proves the override arrived, where a check that the provider was
    // constructed would pass whether it did or not.
    process.env['OPENROUTER_API_KEY'] = 'a-test-key';
    const impl = (async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.5, 0.25] }],
          // No cost, so the configured price is the only way to a number.
          usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const priced = await openRouterFromEnv({
      fetchImpl: impl,
      embeddingsUsdPerMTok: 0.02,
    }).embed({ input: ['a document'], modelVer: 'a/embed', promptVer: 'a-prompt' });
    // One million tokens at 0.02 USD per million is 0.02 USD, in micros.
    expect(priced.costMicros).toBe(20_000);

    await expect(
      openRouterFromEnv({ fetchImpl: impl }).embed({
        input: ['a document'],
        modelVer: 'a/embed',
        promptVer: 'a-prompt',
      }),
    ).rejects.toThrow(/embedding cost unavailable/);
  });

  it('lets an override win over the environment', async () => {
    process.env['OPENROUTER_API_KEY'] = 'a-test-key';
    process.env['OPENROUTER_BASE_URL'] = 'https://gateway.example.test/v1';
    const fetcher = recordingFetch();
    await callOnce(
      openRouterFromEnv({
        fetchImpl: fetcher.impl,
        baseUrl: 'https://explicit.example.test/v1',
      }),
    );
    expect(fetcher.calls[0]?.url).toBe('https://explicit.example.test/v1/chat/completions');
  });
});

// The provider refuses an embedding answer with no cost and names this
// variable. `openRouterFromEnv` and `load-docs` read it through this one
// function, so the variable has one reading.
describe('embeddingPriceFromEnv', () => {
  it('sets no price when the variable is unset or blank', () => {
    expect(embeddingPriceFromEnv({})).toEqual({});
    expect(embeddingPriceFromEnv({ EMBEDDINGS_USD_PER_MTOK: '  ' })).toEqual({});
  });

  it('reads a price of zero or more', () => {
    expect(embeddingPriceFromEnv({ EMBEDDINGS_USD_PER_MTOK: '0.02' })).toEqual({ embeddingsUsdPerMTok: 0.02 });
    expect(embeddingPriceFromEnv({ EMBEDDINGS_USD_PER_MTOK: '0' })).toEqual({ embeddingsUsdPerMTok: 0 });
  });

  it('refuses a price that is not a number of zero or more', () => {
    for (const raw of ['cheap', '-1', 'Infinity', 'NaN']) {
      expect(() => embeddingPriceFromEnv({ EMBEDDINGS_USD_PER_MTOK: raw }), raw)
        .toThrow(`EMBEDDINGS_USD_PER_MTOK must be a number of zero or more, got "${raw}"`);
    }
  });
});
