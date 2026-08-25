import { describe, expect, it } from 'vitest';

import { FakeProvider } from './fake.js';
import { OpenRouterProvider } from './openrouter.js';
import { assertSamplingTemperature } from './provider.js';
import type { DataGuarantee } from './provider.js';

describe('assertSamplingTemperature', () => {
  it('accepts a temperature above zero', () => {
    expect(() => assertSamplingTemperature(0.7)).not.toThrow();
  });

  it('rejects zero and negative temperatures with an error, not a comment', () => {
    expect(() => assertSamplingTemperature(0)).toThrow(/above zero/);
    expect(() => assertSamplingTemperature(-0.1)).toThrow(/above zero/);
  });
});

describe('FakeProvider', () => {
  it('returns scripted chat responses in order and records each call', async () => {
    const provider = new FakeProvider([
      { text: 'billing_refund', costCents: 3 },
      { text: 'shipping_status', costCents: 2 },
    ]);

    const first = await provider.complete({
      messages: [{ role: 'user', content: 'ticket one' }],
      temperature: 0.7,
      promptVer: 'classify@1',
      modelVer: 'test/model-a',
    });
    const second = await provider.complete({
      messages: [{ role: 'user', content: 'ticket two' }],
      temperature: 0.7,
      promptVer: 'classify@1',
      modelVer: 'test/model-a',
    });

    expect(first.text).toBe('billing_refund');
    expect(first.costCents).toBe(3);
    expect(second.text).toBe('shipping_status');
    expect(second.servedModelVer).toBe('test/model-a');

    // DEC-26: every call records the pinned versions.
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]).toMatchObject({
      kind: 'chat',
      promptVer: 'classify@1',
      modelVer: 'test/model-a',
      temperature: 0.7,
    });
  });

  it('scripts embeddings and echoes the pinned versions', async () => {
    const provider = new FakeProvider([{ vectors: [[1, 2], [3, 4]], costCents: 0 }]);

    const result = await provider.embed({
      input: ['doc one', 'doc two'],
      promptVer: 'embed@1',
      modelVer: 'test/embedder',
    });

    expect(result.vectors).toEqual([[1, 2], [3, 4]]);
    expect(result.costCents).toBe(0);
    expect(provider.calls[0]).toMatchObject({
      kind: 'embed',
      promptVer: 'embed@1',
      modelVer: 'test/embedder',
    });
  });

  it('throws when the script is exhausted instead of inventing output', async () => {
    const provider = new FakeProvider([]);
    await expect(
      provider.complete({
        messages: [],
        temperature: 0.5,
        promptVer: 'p@1',
        modelVer: 'm@1',
      }),
    ).rejects.toThrow(/script is exhausted/);
  });

  it('records the effective data guarantee per DEC-17', async () => {
    const provider = new FakeProvider(
      [{ text: 'ok' }, { text: 'ok' }, { text: 'ok' }],
      true,
    );

    await provider.complete({
      messages: [],
      temperature: 0.5,
      promptVer: 'p@1',
      modelVer: 'm@1',
    });
    await provider.complete({
      messages: [],
      temperature: 0.5,
      promptVer: 'p@1',
      modelVer: 'm@1',
      dataGuarantee: { zdrOnly: false },
    });
    await provider.embed({
      input: ['doc'],
      promptVer: 'p@1',
      modelVer: 'm@1',
    });

    expect(provider.calls[0]?.dataGuaranteeZdrOnly).toBe(true);
    // A per-call override wins over the default.
    expect(provider.calls[1]?.dataGuaranteeZdrOnly).toBe(false);
    expect(provider.calls[2]?.dataGuaranteeZdrOnly).toBe(true);
  });
});

describe('OpenRouterProvider (injected fetch, no live calls)', () => {
  const chatResponse = {
    choices: [
      { message: { role: 'assistant', content: 'the routed intent' } },
    ],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 5,
      total_tokens: 1205,
      cost: 0.000841,
    },
    model: 'openai/gpt-4o-mini-2024-07-18',
  };

  type FetchCall = { url: string; init: RequestInit };

  function makeFetch(body: unknown, status = 200): {
    calls: FetchCall[];
    fetchImpl: typeof fetch;
  } {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('maps a chat request onto the OpenRouter API and reports cost in cents', async () => {
    const { fetchImpl } = makeFetch(chatResponse);
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });

    const result = await provider.complete({
      messages: [{ role: 'system', content: 'sys' }],
      temperature: 0.7,
      maxOutputTokens: 64,
      promptVer: 'classify@1',
      modelVer: 'openai/gpt-4o-mini',
    });

    expect(result.text).toBe('the routed intent');
    // DEC-25: USD fraction to integer cents for the cost limit.
    expect(result.costCents).toBe(0);
    expect(result.usage.totalTokens).toBe(1205);
    // DEC-26: record the version the server actually served.
    expect(result.servedModelVer).toBe('openai/gpt-4o-mini-2024-07-18');
  });

  it('rounds a larger cost into honest cents and omits zdr unless configured', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(chatResponse), { status: 200 });
    }) as typeof fetch;

    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.5,
      promptVer: 'p@1',
      modelVer: 'openai/gpt-4o-mini',
    });
    // 0.000841 USD * 100 -> 0 cents; use the raw check below for rounding.
    expect(result.costCents).toBe(0);

    const body = capturedBody!;
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBeUndefined();
    // DEC-17: ZDR defaults to off; forcing it per request is the rejected
    // alternative.
    expect(body.provider).toEqual({});
  });

  it('sends provider.zdr when the data guarantee asks for it', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(chatResponse), { status: 200 });
    }) as typeof fetch;

    const guarantee: DataGuarantee = { zdrOnly: true };
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
    await provider.complete({
      messages: [],
      temperature: 0.5,
      promptVer: 'p@1',
      modelVer: 'm@1',
      dataGuarantee: guarantee,
    });

    expect(capturedBody!.provider).toEqual({ zdr: true, data_collection: 'deny' });
  });

  it('refuses to report zero when OpenRouter omits usage.cost', async () => {
    const noCost = {
      choices: [{ message: { role: 'assistant', content: 'x' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const { fetchImpl } = makeFetch(noCost);
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });

    await expect(
      provider.complete({
        messages: [],
        temperature: 0.5,
        promptVer: 'p@1',
        modelVer: 'm@1',
      }),
    ).rejects.toThrow(/usage\.cost/);
  });

  it('does not log prompts by default, and only logs under the explicit override', async () => {
    const logged: unknown[] = [];

    const quiet = new OpenRouterProvider({
      apiKey: 'k',
      fetchImpl: makeFetch(chatResponse).fetchImpl,
      onPromptLog: (entry) => logged.push(entry),
    });
    await quiet.complete({
      messages: [{ role: 'user', content: 'secret ticket text' }],
      temperature: 0.5,
      promptVer: 'p@1',
      modelVer: 'm@1',
    });
    expect(logged).toHaveLength(0);

    const loud = new OpenRouterProvider({
      apiKey: 'k',
      fetchImpl: makeFetch(chatResponse).fetchImpl,
      promptLogging: true,
      onPromptLog: (entry) => logged.push(entry),
    });
    await loud.complete({
      messages: [{ role: 'user', content: 'secret ticket text' }],
      temperature: 0.5,
      promptVer: 'p@1',
      modelVer: 'm@1',
    });
    expect(logged).toHaveLength(1);
  });

  it('computes embedding cost from the configured price and parses vectors', async () => {
    const embeddingsResponse = {
      data: [
        { index: 0, embedding: [0.1, 0.2] },
        { index: 1, embedding: [0.3, 0.4] },
      ],
      model: 'openai/text-embedding-3-small',
      usage: { prompt_tokens: 1000000, total_tokens: 1000000 },
    };
    const { fetchImpl } = makeFetch(embeddingsResponse);
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      fetchImpl,
      embeddingsUsdPerMTok: 0.02,
    });

    const result = await provider.embed({
      input: ['a', 'b'],
      promptVer: 'embed@1',
      modelVer: 'openai/text-embedding-3-small',
    });

    expect(result.vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(result.costCents).toBe(2); // 1M tokens at $0.02/MTok
    expect(result.servedModelVer).toBe('openai/text-embedding-3-small');
  });

  it('throws on embeddings when neither inline cost nor a configured price exists', async () => {
    const embeddingsResponse = {
      data: [{ index: 0, embedding: [1] }],
      model: 'openai/text-embedding-3-small',
      usage: { prompt_tokens: 10, total_tokens: 10 },
    };
    const { fetchImpl } = makeFetch(embeddingsResponse);
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });

    await expect(
      provider.embed({
        input: ['a'],
        promptVer: 'embed@1',
        modelVer: 'openai/text-embedding-3-small',
      }),
    ).rejects.toThrow(/embeddingsUsdPerMTok/);
  });

  it('surfaces non-2xx responses as errors carrying the status', async () => {
    const { fetchImpl } = makeFetch({ error: 'rate limited' }, 429);
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });

    await expect(
      provider.complete({
        messages: [],
        temperature: 0.5,
        promptVer: 'p@1',
        modelVer: 'm@1',
      }),
    ).rejects.toThrow(/\(429\)/);
  });
});
