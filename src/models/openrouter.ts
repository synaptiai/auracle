import { ProviderHttpError, UnreadableAnswerError } from './provider.js';
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
   * The price of an embedding, in USD per million tokens, for an answer that
   * carries no cost. OpenRouter's /embeddings answer reports its cost in
   * `usage.cost`; a gateway may report token counts only. Without the cost
   * and without this price the cost is unknown, and embed() refuses the
   * answer instead of reporting zero (DEC-25).
   */
  embeddingsUsdPerMTok?: number;
  /**
   * DEC-25 applies a clock limit to a run, but the coordinator can only
   * check it between steps. A request that never returns therefore parks the
   * run forever and no deadline fires. Every call carries this timeout so a
   * stalled provider surfaces as an error the state machine can act on.
   */
  requestTimeoutMs?: number;
  /** Injection point for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Ceiling for one provider call. Long enough for a slow completion. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * USD to integer micro-dollars, matching run.cost_micros (integer >= 0).
 *
 * Cents lost every real call: a completion costing 0.000841 USD rounded to
 * 0, so the ledger recorded nothing and the DEC-25 limit summed zeros. One
 * micro-dollar is one millionth of a dollar, which holds any price this
 * system meets.
 */
function usdToMicros(usd: number): number {
  return Math.max(0, Math.round(usd * 1_000_000));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    // Untyped. A body that does not parse to an object is a malformed
    // response rather than an answer this module could not read, and a
    // gateway artifact belongs with the transport failures the queue retries.
    //
    // This helper reads the transport envelope AND parts of the answer, so
    // the two call sites that read the answer use `shapedRecord` below. An
    // earlier revert typed neither and put two adjacent embed shapes on
    // opposite sides of the line.
    throw new Error('OpenRouter returned a non-object response');
  }
  return value as Record<string, unknown>;
}


interface UsageShape {
  usage: TokenUsage | null;
  usdCost: number | null;
}

/**
 * Reads a record out of the answer, not out of the envelope.
 *
 * A choice that carries no `message`, or an embedding item that is not an
 * object, is a response shape this module cannot read: typed, so the run ends
 * instead of cycling the queue's retry ceiling (DEC-30).
 */
function shapedRecord(value: unknown, shape: string, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new UnreadableAnswerError(`OpenRouter ${what}`, shape);
  }
  return value as Record<string, unknown>;
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

/** What a JSON error body that names no message is reported as. */
const NO_PROVIDER_MESSAGE = 'the provider sent an error with no message';

/**
 * The provider's own account of a failed call, and nothing else from its
 * body. The body can carry more, such as a `metadata.raw` from the upstream
 * model, and an upstream may quote the input it refused. The message goes to
 * the ledger and the log, and an input can be a document that quotes a
 * customer (DEC-19).
 *
 * A JSON body gives its `error.message`, or its `error` when that is a
 * string, and otherwise a fixed sentence: never the body itself. A body that
 * is not JSON stays as it came, because it is then all the diagnosis there
 * is. Either way the API key never appears: a gateway that echoes the
 * request's header would otherwise put it in the ledger.
 */
function providerErrorMessage(text: string, apiKey: string): string {
  let message: string;
  try {
    const parsed: unknown = JSON.parse(text);
    const error = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : undefined;
    const nested = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : error;
    message = typeof nested === 'string' && nested.trim().length > 0 ? nested : NO_PROVIDER_MESSAGE;
  } catch {
    // Not JSON: the text is the whole answer.
    message = text.trim().length > 0 ? text : NO_PROVIDER_MESSAGE;
  }
  return scrubKey(message, apiKey);
}

/**
 * The text with the API key replaced, in the form it was configured and in
 * the form fetch sends, trimmed. A key shorter than any real one would match
 * ordinary words instead, so it is left alone.
 */
function scrubKey(text: string, apiKey: string): string {
  let scrubbed = text;
  for (const key of new Set([apiKey, apiKey.trim()])) {
    if (key.length >= MIN_SCRUBBED_KEY_LENGTH) scrubbed = scrubbed.split(key).join('[the API key]');
  }
  return scrubbed;
}

/** The message of whatever a failed fetch threw. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The shortest key the scrub looks for. Every real provider key is longer. */
const MIN_SCRUBBED_KEY_LENGTH = 8;

async function postJson(
  config: OpenRouterConfig,
  path: string,
  body: unknown,
  callTimeoutMs?: number,
): Promise<Record<string, unknown>> {
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const configured = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  // A call may shorten the deadline, never lengthen it.
  const timeoutMs = callTimeoutMs === undefined ? configured : Math.min(callTimeoutMs, configured);
  let response: Response;
  let text: string;
  try {
    response = await doFetch(`${config.baseUrl ?? DEFAULT_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // Without this the call can hang forever. The run's clock limit is
      // only checked between steps, so nothing else would ever stop it.
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Inside the guard: the deadline covers the body too, and a stall while
    // reading it is the same timeout as a stall before the headers.
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(
        `OpenRouter request to ${path} exceeded ${timeoutMs}ms and was aborted`,
      );
    }
    // A transport error can quote the request: fetch refuses a header value
    // it cannot send by quoting it whole, key and all. So the error is
    // rebuilt from its scrubbed message, with no `cause`, which the CLI's
    // fault printer would walk back to the original.
    const scrubbed = new Error(scrubKey(errorText(error), config.apiKey));
    if (error instanceof Error) scrubbed.name = error.name;
    throw scrubbed;
  }
  if (!response.ok) {
    throw new ProviderHttpError(
      `OpenRouter request failed (${response.status}): ${providerErrorMessage(text, config.apiKey)}`,
      response.status,
    );
  }
  return asRecord(JSON.parse(text));
}

// A response whose shape this module cannot read is a fault the provider will
// reproduce, so it is typed and escalates. A transport failure, a timeout and
// an HTTP status are transient and stay untyped, so the queue still retries
// them (DEC-30).

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
    // Field-wise, not a spread: a per-call `{ zdrOnly: undefined }` is a
    // present key, and a spread would overwrite a configured true with it,
    // turning the guarantee off silently.
    const merged = { zdrOnly: perCall?.zdrOnly ?? this.config.dataGuarantee?.zdrOnly };
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
      throw new UnreadableAnswerError('OpenRouter chat response has no choices', 'no-choices');
    }
    const message = shapedRecord(
      shapedRecord(choices[0], 'no-choice', 'choice is not an object').message,
      'no-message',
      'chat choice carries no message',
    );
    // Truncation is decided first, and before the shape of the content, because
    // the worst truncation has no content at all: a model that spends the whole
    // budget reasoning returns a null content with finish_reason 'length'. That
    // is the only truncation this repository has actually observed, and an
    // earlier ordering of these two checks reported it as an untyped fault that
    // no caller could tell from a protocol error. It then propagated uncaught,
    // which is the defect the typed fault exists to remove (DEC-30).
    //
    // The usage is parsed first so the fault can carry the spend. A truncated
    // call exhausted its budget by definition, so it is the most expensive call
    // of the run, and dropping its cost understates the run (DEC-25).
    const parsed = parseUsage(response.usage);
    const finishReason = asRecord(choices[0]!).finish_reason;
    if (finishReason === 'length') {
      // DEC-25 refuses to report a cost of zero as though it were measured,
      // and the fault must stay typed: every handler discriminates on this
      // type, so an untyped throw here skips the compose catch, the gate
      // catch, the meter's credit and the fitting job's drop, and the run
      // never terminates. The two rules meet by saying the spend is unknown
      // rather than by saying it is zero, or by saying nothing at all.
      const known = parsed.usdCost !== null;
      throw new UnreadableAnswerError(
        `the model stopped at the answer budget of ${String(call.maxOutputTokens ?? 'unset')} `
          + `tokens for ${call.modelVer}; the answer is incomplete and is not a result`
          + (known ? '' : '; the provider reported no cost for it (DEC-25)'),
        'truncated',
        known ? usdToMicros(parsed.usdCost as number) : 0,
        !known,
      );
    }

    const content = message.content;
    if (typeof content !== 'string') {
      // Typed like its neighbours. A content filter, a provider error, or a
      // reasoning model that emits only a reasoning field all land here on a
      // finish reason other than 'length', and an untyped throw skips every
      // handler and leaves the run non-terminal (DEC-30).
      throw new UnreadableAnswerError(
        'OpenRouter chat choice has no text content',
        'no-content',
        parsed.usdCost === null ? 0 : usdToMicros(parsed.usdCost),
        parsed.usdCost === null,
      );
    }
    if (parsed.usdCost === null || parsed.usage === null) {
      // Typed, for the same reason the truncated branch above is: a response
      // shape the provider will reproduce is not transient, and an untyped
      // throw here skips every handler and leaves the run non-terminal. The
      // cost is unknown rather than zero (DEC-25, DEC-30).
      throw new UnreadableAnswerError(
        'OpenRouter chat response carries no usage.cost; refusing to report zero (DEC-25)',
        'no-cost',
        0,
        true,
      );
    }
    const servedModelVer =
      typeof response.model === 'string' ? response.model : call.modelVer;

    return {
      text: content,
      costMicros: usdToMicros(parsed.usdCost),
      usage: parsed.usage,
      servedModelVer,
    };
  }

  async embed(
    call: PinnedVersions & {
      input: string[];
      timeoutMs?: number;
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

    const response = await postJson(this.config, '/embeddings', body, call.timeoutMs);

    // The cost first (DEC-25): every refusal below is of a call already paid
    // for, so each carries what it cost, or says that the cost is unknown.
    const parsed = parseUsage(response.usage);
    let costMicros = 0;
    let costUnknown = true;
    if (parsed.usage !== null) {
      const price = this.config.embeddingsUsdPerMTok;
      const usd = parsed.usdCost ?? (price === undefined ? null : (parsed.usage.totalTokens / 1_000_000) * price);
      if (usd !== null) {
        costMicros = usdToMicros(usd);
        costUnknown = false;
      }
    }
    const unreadable = (message: string, shape: string): UnreadableAnswerError =>
      new UnreadableAnswerError(message, shape, costMicros, costUnknown);

    const data = response.data;
    if (!Array.isArray(data)) {
      throw unreadable('OpenRouter embeddings response has no data array', 'no-data');
    }
    // Placed by each item's own `index`, not by the order it arrived in: a
    // caller writes vector i to input i, so a reordered answer would give
    // every document another's vector, and nothing downstream could tell.
    const placed: Record<string, unknown>[] = new Array<Record<string, unknown>>(data.length);
    for (const [position, item] of data.entries()) {
      if (typeof item !== 'object' || item === null) {
        throw unreadable('OpenRouter embedding item is not an object', 'no-item');
      }
      const record = item as Record<string, unknown>;
      const index = record.index === undefined ? position : record.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= data.length
        || placed[index] !== undefined) {
        throw unreadable('OpenRouter embedding items carry no usable index', 'bad-index');
      }
      placed[index] = record;
    }
    const vectors = placed.map((record) => {
      const embedding = record.embedding;
      if (!Array.isArray(embedding)) {
        throw unreadable('OpenRouter embedding item has no vector', 'no-vector');
      }
      return embedding.map((component) => {
        if (typeof component !== 'number') {
          throw unreadable('OpenRouter embedding vector has a non-number component', 'bad-vector');
        }
        return component;
      });
    });

    if (parsed.usage === null) {
      throw unreadable('OpenRouter embeddings response carries no usage (DEC-25)', 'no-usage');
    }
    if (costUnknown) {
      // Typed, as the chat path's unknown cost is: the fault is the
      // configuration and repeats on every call, so a run escalates once
      // rather than paying for each retry.
      throw unreadable(
        'embedding cost unavailable: set EMBEDDINGS_USD_PER_MTOK to keep DEC-25 accounting truthful',
        'no-cost',
      );
    }

    return {
      vectors,
      costMicros,
      usage: parsed.usage,
      servedModelVer:
        typeof response.model === 'string' ? response.model : call.modelVer,
    };
  }
}
