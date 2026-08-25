import type {
  ChatRequest,
  ChatResult,
  DataGuarantee,
  EmbeddingResult,
  ModelProvider,
  PinnedVersions,
  TokenUsage,
} from './provider.js';

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;
  /** DEC-17 defaults applied when a call does not pass its own guarantee. */
  dataGuarantee?: DataGuarantee;
  /**
   * Section 6: the prompt-log path is off by default and needs this explicit
   * override. When true, every call hands the raw prompt to onPromptLog;
   * the caller owns storage. Nothing is logged when the flag is absent.
   */
  promptLogging?: boolean;
  onPromptLog?: (entry: { kind: 'chat' | 'embed'; payload: unknown }) => void;
  /**
   * OpenRouter's /embeddings response carries token counts but no inline
   * cost. Set the adopter's price in USD per million tokens so DEC-25
   * accounting stays truthful; without it, embedding cost is unknown and
   * embed() throws instead of reporting zero.
   */
  embeddingsUsdPerMTok?: number;
  /** Injection point for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** USD fraction to integer cents, matching run.cost_cents (integer >= 0). */
function usdToCents(usd: number): number {
  return Math.max(0, Math.round(usd * 100));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('OpenRouter returned a non-object response');
  }
  return value as Record<string, unknown>;
}


interface UsageShape {
  usage: TokenUsage | null;
  usdCost: number | null;
}

function parseUsage(raw: unknown): UsageShape {
  if (typeof raw !== 'object' || raw === null) {
    return { usage: null, usdCost: null };
  }
  const usage = raw as Record<string, unknown>;
  const tokens = {
    promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
    completionTokens:
      typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : 0,
  };
  return {
    usage: tokens,
    usdCost: typeof usage.cost === 'number' ? usage.cost : null,
  };
}

async function postJson(
  config: OpenRouterConfig,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const response = await doFetch(`${config.baseUrl ?? DEFAULT_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter request failed (${response.status}): ${text}`);
  }
  return asRecord(JSON.parse(text));
}

/**
 * The one model provider (DEC-16). Speaks OpenRouter's OpenAI-compatible
 * HTTP API directly. Every result records the served model id next to the
 * pinned versions the caller supplied (DEC-26) and the cost in integer
 * cents for the DEC-25 limits.
 */
export class OpenRouterProvider implements ModelProvider {
  constructor(private readonly config: OpenRouterConfig) {}

  private maybeLog(kind: 'chat' | 'embed', payload: unknown): void {
    if (this.config.promptLogging === true && this.config.onPromptLog) {
      this.config.onPromptLog({ kind, payload });
    }
  }

  private zdrEnabled(perCall: DataGuarantee | undefined): boolean {
    // DEC-17 rejects forcing ZDR on each request, so absence means off.
    const merged = { ...this.config.dataGuarantee, ...perCall };
    return merged.zdrOnly === true;
  }

  async complete(
    call: ChatRequest & PinnedVersions & { dataGuarantee?: DataGuarantee },
  ): Promise<ChatResult> {
    const zdr = this.zdrEnabled(call.dataGuarantee);
    const body: Record<string, unknown> = {
      model: call.modelVer,
      messages: call.messages,
      temperature: call.temperature,
      provider: {
        ...(zdr ? { zdr: true } : {}),
        ...(zdr ? { data_collection: 'deny' } : {}),
      },
    };
    if (call.maxOutputTokens !== undefined) {
      body.max_tokens = call.maxOutputTokens;
    }
    this.maybeLog('chat', body);

    const response = await postJson(this.config, '/chat/completions', body);
    const choices = response.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error('OpenRouter chat response has no choices');
    }
    const message = asRecord(
      asRecord(choices[0]!).message as unknown,
    );
    const content = message.content;
    if (typeof content !== 'string') {
      throw new Error('OpenRouter chat choice has no text content');
    }

    const parsed = parseUsage(response.usage);
    if (parsed.usdCost === null || parsed.usage === null) {
      throw new Error(
        'OpenRouter chat response carries no usage.cost; refusing to report zero (DEC-25)',
      );
    }
    const servedModelVer =
      typeof response.model === 'string' ? response.model : call.modelVer;

    return {
      text: content,
      costCents: usdToCents(parsed.usdCost),
      usage: parsed.usage,
      servedModelVer,
    };
  }

  async embed(
    call: PinnedVersions & {
      input: string[];
      dataGuarantee?: DataGuarantee;
    },
  ): Promise<EmbeddingResult> {
    const zdr = this.zdrEnabled(call.dataGuarantee);
    const body: Record<string, unknown> = {
      model: call.modelVer,
      input: call.input,
      provider: {
        ...(zdr ? { zdr: true } : {}),
        ...(zdr ? { data_collection: 'deny' } : {}),
      },
    };
    this.maybeLog('embed', body);

    const response = await postJson(this.config, '/embeddings', body);
    const data = response.data;
    if (!Array.isArray(data)) {
      throw new Error('OpenRouter embeddings response has no data array');
    }
    const vectors = data.map((item) => {
      const record = asRecord(item);
      const embedding = record.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error('OpenRouter embedding item has no vector');
      }
      return embedding.map((component) => {
        if (typeof component !== 'number') {
          throw new Error('OpenRouter embedding vector has a non-number component');
        }
        return component;
      });
    });

    const parsed = parseUsage(response.usage);
    if (parsed.usage === null) {
      throw new Error('OpenRouter embeddings response carries no usage (DEC-25)');
    }
    let usdCost = parsed.usdCost;
    if (usdCost === null) {
      const price = this.config.embeddingsUsdPerMTok;
      if (price === undefined) {
        throw new Error(
          'embedding cost unavailable: set embeddingsUsdPerMTok to keep DEC-25 accounting truthful',
        );
      }
      usdCost = (parsed.usage.totalTokens / 1_000_000) * price;
    }

    return {
      vectors,
      costCents: usdToCents(usdCost),
      usage: parsed.usage,
      servedModelVer:
        typeof response.model === 'string' ? response.model : call.modelVer,
    };
  }
}
