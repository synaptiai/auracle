import { describe, expect, it } from 'vitest';

import { FakeProvider } from './fake.js';
import { ProviderHttpError, UnreadableAnswerError } from './provider.js';
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
      { text: 'billing_refund', costMicros: 3 },
      { text: 'shipping_status', costMicros: 2 },
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
    expect(first.costMicros).toBe(3);
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
    const provider = new FakeProvider([{ vectors: [[1, 2], [3, 4]], costMicros: 0 }]);

    const result = await provider.embed({
      input: ['doc one', 'doc two'],
      promptVer: 'embed@1',
      modelVer: 'test/embedder',
    });

    expect(result.vectors).toEqual([[1, 2], [3, 4]]);
    expect(result.costMicros).toBe(0);
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
    // DEC-25: 0.000841 USD is 841 micro-dollars. In cents it rounded to 0,
    // so the ledger recorded nothing for a call that really cost money.
    expect(result.costMicros).toBe(841);
    expect(result.usage.totalTokens).toBe(1205);
    // DEC-26: record the version the server actually served.
    expect(result.servedModelVer).toBe('openai/gpt-4o-mini-2024-07-18');
  });

  it('keeps a sub-cent cost instead of rounding it away, and omits zdr unless configured', async () => {
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
    // 0.000841 USD is 841 micro-dollars. The old cents unit reported 0 here,
    // which is what made the DEC-25 limit compare a sum of zeros.
    expect(result.costMicros).toBe(841);

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

  it('refuses a truncated completion instead of returning the part that arrived', async () => {
    // The pinned models reason before they answer and the provider bills that
    // reasoning against the answer budget, so an exhausted budget returns a
    // partial answer or none at all with finish_reason 'length'. Returning it
    // let each caller infer truncation from the shape of the text, and every
    // caller inferred it differently.
    const { fetchImpl } = makeFetch({
      ...chatResponse,
      choices: [
        { finish_reason: 'length', message: { role: 'assistant', content: 'VERDICT: SUPP' } },
      ],
    });
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
    await expect(
      provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxOutputTokens: 16,
        promptVer: 'p',
        modelVer: 'm',
      }),
    ).rejects.toBeInstanceOf(UnreadableAnswerError);
  });

  it('refuses a truncation that carries no content at all', async () => {
    // The worst truncation: the model spent the whole budget reasoning and
    // returned no content. This is the only truncation this repository has
    // observed, and it must read as the same typed fault as a partial answer,
    // not as a protocol error no caller can classify.
    const { fetchImpl } = makeFetch({
      ...chatResponse,
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }],
    });
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
    await expect(
      provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxOutputTokens: 16,
        promptVer: 'p',
        modelVer: 'm',
      }),
    ).rejects.toBeInstanceOf(UnreadableAnswerError);
  });

  it('carries the spend of the call it refused (DEC-25)', async () => {
    const { fetchImpl } = makeFetch({
      ...chatResponse,
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }],
    });
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
    const caught = await provider
      .complete({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxOutputTokens: 16,
        promptVer: 'p',
        modelVer: 'm',
      })
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(UnreadableAnswerError);
    // usage.cost 0.000841 -> 841 micro-dollars.
    expect((caught as UnreadableAnswerError).costMicros).toBe(841);
  });

  it('keeps a truncated call typed when the provider reports no cost (DEC-25)', async () => {
    // Every handler discriminates on the type. An untyped throw here skipped
    // the compose catch, the gate catch, the meter's credit and the fitting
    // job's drop, and the run never terminated. DEC-25 is honoured by saying
    // the spend is unknown, not by abandoning the fault type.
    const { usage: _drop, ...noUsage } = chatResponse;
    const { fetchImpl } = makeFetch({
      ...noUsage,
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }],
    });
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
    await expect(
      provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxOutputTokens: 16,
        promptVer: 'p',
        modelVer: 'm',
      }),
    ).rejects.toBeInstanceOf(UnreadableAnswerError);
  });

  it('says the spend is unknown rather than reporting it as zero (DEC-25)', async () => {
    // Asserted on what the provider throws, not on a constructor. An earlier
    // version built the error itself and checked that a parameter property
    // stored its argument, which tests the language and not this module.
    const { usage: _drop, ...noUsage } = chatResponse;
    const { fetchImpl } = makeFetch({
      ...noUsage,
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }],
    });
    const caught = await new OpenRouterProvider({ apiKey: 'k', fetchImpl })
      .complete({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxOutputTokens: 16,
        promptVer: 'p',
        modelVer: 'm',
      })
      .then(() => null)
      .catch((e: unknown) => e as UnreadableAnswerError);
    expect(caught).toBeInstanceOf(UnreadableAnswerError);
    expect(caught?.costUnknown).toBe(true);
    expect(caught?.costMicros).toBe(0);
  });

  it('reports a known cost as known', async () => {
    const { fetchImpl } = makeFetch({
      ...chatResponse,
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }],
    });
    const caught = await new OpenRouterProvider({ apiKey: 'k', fetchImpl })
      .complete({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxOutputTokens: 16,
        promptVer: 'p',
        modelVer: 'm',
      })
      .then(() => null)
      .catch((e: unknown) => e as UnreadableAnswerError);
    expect(caught).toBeInstanceOf(UnreadableAnswerError);
    expect(caught?.costUnknown).toBe(false);
    expect(caught?.costMicros).toBe(841);
  });

  it('types a missing cost on a finish reason that is not length (DEC-25, DEC-30)', async () => {
    // The two tests named for this behaviour both set finish_reason 'length',
    // which returns at the truncated branch above and never reaches this code.
    // Reverting this throw to an untyped Error left the whole suite green.
    const { usage: _drop, ...noUsage } = chatResponse;
    const { fetchImpl } = makeFetch({
      ...noUsage,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
    });
    const caught = await new OpenRouterProvider({ apiKey: 'k', fetchImpl })
      .complete({ messages: [{ role: 'user', content: 'hi' }], temperature: 0,
        promptVer: 'p', modelVer: 'm' })
      .then(() => null)
      .catch((e: unknown) => e as UnreadableAnswerError);
    expect(caught).toBeInstanceOf(UnreadableAnswerError);
    expect(caught?.shape).toBe('no-cost');
    expect(caught?.costUnknown).toBe(true);
  });

  it('types a response whose choice carries no text at all (DEC-30)', async () => {
    const { fetchImpl } = makeFetch({
      ...chatResponse,
      choices: [{ finish_reason: 'content_filter', message: { role: 'assistant' } }],
    });
    const caught = await new OpenRouterProvider({ apiKey: 'k', fetchImpl })
      .complete({ messages: [{ role: 'user', content: 'hi' }], temperature: 0,
        promptVer: 'p', modelVer: 'm' })
      .then(() => null)
      .catch((e: unknown) => e as UnreadableAnswerError);
    expect(caught).toBeInstanceOf(UnreadableAnswerError);
    expect(caught?.shape).toBe('no-content');
    // The provider priced this call, so the fault carries what it cost.
    expect(caught?.costMicros).toBe(841);
  });

  it('types every chat response shape it cannot read (DEC-30)', async () => {
    // Seven shapes were typed in one commit and two got cases. A typed fault
    // with no case is the class that has produced a finding in three cycles.
    const cases: [string, unknown][] = [
      ['no-choices', { ...chatResponse, choices: [] }],
      // A choice carrying a streaming delta, or an error object where the
      // message belongs. Typing this went missing in a revert.
      ['no-message', { ...chatResponse, choices: [{ finish_reason: 'stop' }] }],
      // A choice that is not an object at all. This shape shipped typed, with
      // a runbook row and no case, while both its siblings had one. Reverting
      // it to the untyped envelope reader leaves every other case here green,
      // so the case is the only thing that holds the split.
      ['no-choice', { ...chatResponse, choices: [42] }],
    ];
    for (const [shape, body] of cases) {
      const { fetchImpl } = makeFetch(body);
      const caught = await new OpenRouterProvider({ apiKey: 'k', fetchImpl })
        .complete({ messages: [{ role: 'user', content: 'hi' }], temperature: 0,
          promptVer: 'p', modelVer: 'm' })
        .then(() => null)
        .catch((e: unknown) => e as UnreadableAnswerError);
      expect(caught, shape).toBeInstanceOf(UnreadableAnswerError);
      expect(caught?.shape).toBe(shape);
    }
  });

  it('types every embeddings response shape it cannot read (DEC-30)', async () => {
    const usage = { prompt_tokens: 1, total_tokens: 1, cost: 0.0001 };
    const cases: [string, unknown][] = [
      ['no-data', { usage }],
      ['no-item', { data: [42], usage }],
      ['no-vector', { data: [{}], usage }],
      ['bad-vector', { data: [{ embedding: [1, 'x'] }], usage }],
      ['no-usage', { data: [{ embedding: [1, 2] }] }],
    ];
    for (const [shape, body] of cases) {
      const { fetchImpl } = makeFetch(body);
      const caught = await new OpenRouterProvider({ apiKey: 'k', fetchImpl })
        .embed({ input: ['hi'], promptVer: 'p', modelVer: 'm' })
        .then(() => null)
        .catch((e: unknown) => e as UnreadableAnswerError);
      expect(caught, shape).toBeInstanceOf(UnreadableAnswerError);
      expect(caught?.shape).toBe(shape);
    }
  });

  it('returns a completion that stopped on its own', async () => {
    const { fetchImpl } = makeFetch({
      ...chatResponse,
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: 'the routed intent' } },
      ],
    });
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      promptVer: 'p',
      modelVer: 'm',
    });
    expect(result.text).toBe('the routed intent');
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
    ).rejects.toBeInstanceOf(UnreadableAnswerError);
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
    expect(result.costMicros).toBe(20_000); // 1M tokens at $0.02/MTok
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
    ).rejects.toThrow(/EMBEDDINGS_USD_PER_MTOK/);
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

  // A caller tells a refusal of its input from a fault of the service by the
  // status, so the error carries it as a number, and on an embedding call too.
  // DEC-19: the message reaches the ledger and the log, so it keeps the
  // provider's own message and none of the rest of the body.
  it("keeps only the provider's message from an error body", async () => {
    const body = {
      error: {
        message: 'Invalid input: maximum input length is 8192 tokens.',
        code: 400,
        metadata: { raw: 'the refused input, quoted: Synthetic Customer wrote in about order 41' },
      },
    };
    const { fetchImpl } = makeFetch(body, 400);
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
    const refused: unknown = await provider
      .embed({ input: ['a'], promptVer: 'p@1', modelVer: 'm@1' })
      .catch((error: unknown) => error);
    expect((refused as Error).message).toBe('OpenRouter request failed (400): Invalid input: maximum input length is 8192 tokens.');

    // A string `error` is the message. A JSON body that names none is a
    // fixed sentence, never the body, whatever else it carries.
    for (const [shape, expected] of [
      [{ error: 'input too long', input: 'Synthetic Customer wrote in about order 41' }, 'input too long'],
      [{ error: { code: 400, metadata: { raw: 'Synthetic Customer wrote in' } } }, 'the provider sent an error with no message'],
      [{ error: { message: '' } }, 'the provider sent an error with no message'],
      [{ detail: 'Synthetic Customer wrote in' }, 'the provider sent an error with no message'],
    ] as const) {
      const shaped = new OpenRouterProvider({ apiKey: 'k', fetchImpl: makeFetch(shape, 400).fetchImpl });
      await expect(shaped.embed({ input: ['a'], promptVer: 'p@1', modelVer: 'm@1' }), JSON.stringify(shape))
        .rejects.toThrow(new RegExp(`^OpenRouter request failed \\(400\\): ${expected}$`));
    }

    // A body that is not the JSON error shape is the only diagnosis, and stays.
    const bare = new OpenRouterProvider({
      apiKey: 'k',
      fetchImpl: (async () => new Response('Bad Gateway', { status: 502 })) as typeof fetch,
    });
    await expect(bare.embed({ input: ['a'], promptVer: 'p@1', modelVer: 'm@1' }))
      .rejects.toThrow('OpenRouter request failed (502): Bad Gateway');

    // A gateway that echoes the request's header never puts the key in the
    // ledger or the log.
    const echoing = new OpenRouterProvider({
      apiKey: 'sk-synthetic-0000',
      fetchImpl: (async () => new Response('rejected Bearer sk-synthetic-0000', { status: 401 })) as typeof fetch,
    });
    await expect(echoing.embed({ input: ['a'], promptVer: 'p@1', modelVer: 'm@1' }))
      .rejects.toThrow('OpenRouter request failed (401): rejected Bearer [the API key]');

    // The same for a JSON message, and for a key configured with the
    // whitespace a secret file leaves, which fetch trims before sending.
    const jsonEcho = new OpenRouterProvider({
      apiKey: 'sk-synthetic-0000\n',
      fetchImpl: makeFetch({ error: { message: 'no such key sk-synthetic-0000' } }, 401).fetchImpl,
    });
    await expect(jsonEcho.embed({ input: ['a'], promptVer: 'p@1', modelVer: 'm@1' }))
      .rejects.toThrow('OpenRouter request failed (401): no such key [the API key]');
  });

  // fetch refuses a header value it cannot send by quoting it whole, and that
  // error reaches the ledger and the log. A key with a line break inside it
  // is such a value. Driven through the real fetch: it refuses before it
  // opens any connection.
  it('keeps the key out of an error that fetch raises itself', async () => {
    const key = 'sk-synthetic-0000\nexport OTHER=1';
    const provider = new OpenRouterProvider({ apiKey: key, baseUrl: 'http://127.0.0.1:9/v1' });
    const raised: unknown = await provider
      .embed({ input: ['a'], promptVer: 'p@1', modelVer: 'm@1' })
      .catch((error: unknown) => error);
    expect(raised).toBeInstanceOf(Error);
    const error = raised as Error;
    expect(error.message).not.toContain('sk-synthetic-0000');
    expect(error.message).toContain('[the API key]');
    expect(error.cause).toBeUndefined();

    // The same for any error an injected fetch raises that quotes the key.
    const quoting = new OpenRouterProvider({
      apiKey: 'sk-synthetic-1111',
      fetchImpl: (async () => {
        throw new TypeError('cannot send Bearer sk-synthetic-1111');
      }) as typeof fetch,
    });
    await expect(quoting.embed({ input: ['a'], promptVer: 'p@1', modelVer: 'm@1' }))
      .rejects.toMatchObject({ name: 'TypeError', message: 'cannot send Bearer [the API key]' });
  });

  // DEC-25: an answer the module cannot read was still paid for, so the
  // refusal carries its cost, or says that the cost is unknown.
  it('carries the cost on an embedding answer it cannot read', async () => {
    const call = { input: ['a', 'b'], promptVer: 'p@1', modelVer: 'm@1' };
    const badIndex = new OpenRouterProvider({
      apiKey: 'k',
      fetchImpl: makeFetch({
        data: [{ index: 0, embedding: [0.1] }, { index: 0, embedding: [0.2] }],
        usage: { prompt_tokens: 2, total_tokens: 2, cost: 0.01 },
      }).fetchImpl,
    });
    const refused: unknown = await badIndex.embed(call).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UnreadableAnswerError);
    // 0.01 USD is 10,000 micro-dollars.
    expect(refused).toMatchObject({ shape: 'bad-index', costMicros: 10_000, costUnknown: false });

    const noUsage = new OpenRouterProvider({
      apiKey: 'k',
      fetchImpl: makeFetch({ data: [{ embedding: [0.1] }, { embedding: [0.2] }] }).fetchImpl,
    });
    await expect(noUsage.embed(call)).rejects.toMatchObject({ shape: 'no-usage', costMicros: 0, costUnknown: true });

    // No cost and no price: typed, so a run escalates once, cost unknown.
    const noPrice = new OpenRouterProvider({
      apiKey: 'k',
      fetchImpl: makeFetch({ data: [{ embedding: [0.1] }, { embedding: [0.2] }], usage: { prompt_tokens: 2, total_tokens: 2 } }).fetchImpl,
    });
    await expect(noPrice.embed(call)).rejects.toMatchObject({ shape: 'no-cost', costUnknown: true });
  });

  // A caller writes vector i to input i, so the answer is placed by each
  // item's own index, whatever order it arrives in.
  it('places each embedding by its index, not its arrival', async () => {
    const usage = { prompt_tokens: 2, total_tokens: 2, cost: 0.000001 };
    const reversed = new OpenRouterProvider({
      apiKey: 'k',
      fetchImpl: makeFetch({ data: [{ index: 1, embedding: [0.2] }, { index: 0, embedding: [0.1] }], usage }).fetchImpl,
    });
    const result = await reversed.embed({ input: ['first', 'second'], promptVer: 'p@1', modelVer: 'm@1' });
    expect(result.vectors).toEqual([[0.1], [0.2]]);

    // No index at all keeps the order the items arrived in.
    const plain = new OpenRouterProvider({
      apiKey: 'k',
      fetchImpl: makeFetch({ data: [{ embedding: [0.1] }, { embedding: [0.2] }], usage }).fetchImpl,
    });
    await expect(plain.embed({ input: ['first', 'second'], promptVer: 'p@1', modelVer: 'm@1' }))
      .resolves.toMatchObject({ vectors: [[0.1], [0.2]] });

    for (const data of [
      [{ index: 0, embedding: [0.1] }, { index: 0, embedding: [0.2] }],
      [{ index: 0, embedding: [0.1] }, { index: 2, embedding: [0.2] }],
      [{ index: '0', embedding: [0.1] }],
    ]) {
      const bad = new OpenRouterProvider({ apiKey: 'k', fetchImpl: makeFetch({ data, usage }).fetchImpl });
      await expect(bad.embed({ input: data.map(() => 'x'), promptVer: 'p@1', modelVer: 'm@1' }), JSON.stringify(data))
        .rejects.toThrow(UnreadableAnswerError);
    }
  });

  it('types a non-2xx embedding response with its status', async () => {
    const { fetchImpl } = makeFetch({ error: 'input too long' }, 400);
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
    const refused = await provider
      .embed({ input: ['a'], promptVer: 'p@1', modelVer: 'm@1' })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProviderHttpError);
    expect((refused as ProviderHttpError).status).toBe(400);
    // Not the typed fault the queue escalates: it still retries (DEC-30).
    expect(refused).not.toBeInstanceOf(UnreadableAnswerError);
  });

  // The headers arrive and the body stalls. The deadline covers the body,
  // and the error names the path and the deadline as a stalled send does.
  it('names the deadline when the body stalls after the headers', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl, requestTimeoutMs: 20 });
    await expect(provider.embed({ input: ['a'], promptVer: 'p@1', modelVer: 'm@1' }))
      .rejects.toThrow('OpenRouter request to /embeddings exceeded 20ms and was aborted');
  });

  it('aborts a request that never returns, so a run cannot hang forever', async () => {
    // The run's clock limit (DEC-25) is only checked between steps, so a
    // provider that never answers would park the run with nothing to stop
    // it. Every request therefore carries its own deadline.
    const seen: Array<AbortSignal | undefined> = [];
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined);
      // Never resolves on its own; only the abort signal ends this.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('aborted'));
        });
      });
    }) as typeof fetch;

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      fetchImpl,
      requestTimeoutMs: 20,
    });

    await expect(
      provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
        promptVer: 'p@1',
        modelVer: 'm@1',
      }),
    ).rejects.toThrow(/exceeded 20ms/);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  // A caller holding other work while it waits asks for a shorter deadline,
  // and a longer one than the provider's is never granted.
  it('lets an embedding call shorten its deadline, never lengthen it', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('aborted'));
        });
      })) as typeof fetch;
    const call = { input: ['a'], promptVer: 'p@1', modelVer: 'm@1' };

    const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl: hanging, requestTimeoutMs: 5_000 });
    const started = Date.now();
    await expect(provider.embed({ ...call, timeoutMs: 20 })).rejects.toThrow(/exceeded 20ms/);
    // The call stops at its own deadline, not at the provider's five seconds.
    expect(Date.now() - started).toBeLessThan(2_000);

    const short = new OpenRouterProvider({ apiKey: 'k', fetchImpl: hanging, requestTimeoutMs: 20 });
    await expect(short.embed({ ...call, timeoutMs: 5_000 })).rejects.toThrow(/exceeded 20ms/);
  });
});
