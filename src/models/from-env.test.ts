// One construction of the model provider (issue #72).
//
// The provider keeps its config private, so these assert the behaviour an
// adopter actually observes: which host the call goes to, what the
// Authorization header carries, and whether DEC-17's zero-retention flag is
// on the request body.
import { afterEach, describe, expect, it } from 'vitest';

import { openRouterFromEnv } from './from-env.js';

const TOUCHED = ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'AURACLE_ZDR_ONLY'] as const;
const saved = new Map<string, string | undefined>();
for (const name of TOUCHED) saved.set(name, process.env[name]);

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
