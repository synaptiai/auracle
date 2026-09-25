/**
 * The model port (section 4.5-4.7). DEC-16: OpenRouter supplies the models,
 * through one provider only. The Vercel AI SDK is a rejected alternative
 * (DEC-16, third column), so this port speaks OpenRouter's OpenAI-compatible
 * HTTP API directly.
 *
 * DEC-26: every call carries a pinned prompt_ver and model_ver. The caller
 * pins them; the provider records what the server actually served.
 * DEC-25: every result reports cost in integer micro-dollars for the run limits.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * DEC-17: the data guarantee is configurable and documented. Forcing zero
 * data retention on each request is the rejected alternative, so `zdrOnly`
 * defaults to false and the adopter chooses.
 */
export interface DataGuarantee {
  /** Route only to endpoints that declare a zero-data-retention policy. */
  zdrOnly?: boolean;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /**
   * Configurable per call. Section 4.5: the classifier samples at a
   * temperature above zero. Enforce that at the classifier call site with
   * assertSamplingTemperature — not with a comment.
   */
  temperature: number;
  maxOutputTokens?: number;
}

/** The pinned versions (DEC-26). Present on every call, echoed in every result. */
export interface PinnedVersions {
  promptVer: string;
  modelVer: string;
}

export interface EmbeddingRequest {
  input: string[];
  /**
   * A shorter deadline for this call than the provider's own. A caller that
   * holds other work while it waits sets it, so a stalled call delays that
   * work by this much at most.
   */
  timeoutMs?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  text: string;
  /** DEC-25: integer micro-dollars, for the coordinator's cost limit. */
  costMicros: number;
  usage: TokenUsage;
  /** The model id the server reports it served. May differ from the request. */
  servedModelVer: string;
}

export interface EmbeddingResult {
  vectors: number[][];
  costMicros: number;
  usage: TokenUsage;
  servedModelVer: string;
}

export interface ModelProvider {
  /**
   * What actually answers a call.
   *
   * A published number must not claim a model produced it when a stub did.
   * Deriving that from the requested pin is unsound: `provider` and
   * `modelVer` are independent options, so a stub answering under a real
   * model's version would report `scored_by: 'model'`. Absent means 'model',
   * which keeps every existing provider correct.
   */
  readonly kind?: 'stub' | 'model';
  complete(
    call: ChatRequest & PinnedVersions & { dataGuarantee?: DataGuarantee },
  ): Promise<ChatResult>;
  embed(
    call: EmbeddingRequest & PinnedVersions & { dataGuarantee?: DataGuarantee },
  ): Promise<EmbeddingResult>;
}

/**
 * Section 4.5 warning, as code. At a temperature of zero all samples are the
 * same, agreement is always 1.0, and the gate passes each ticket.
 */
export function assertSamplingTemperature(temperature: number): void {
  if (!(temperature > 0)) {
    throw new Error(
      `sampling temperature must be above zero, got ${temperature} (section 4.5)`,
    );
  }
}

/**
 * The model answered, and the answer carries nothing the caller can read.
 *
 * A fault, not a determination. The pinned models reason before they answer
 * and the provider bills that reasoning against the answer budget, so an
 * exhausted budget returns an empty answer rather than an error. Scoring that
 * emptiness as a verdict, or as a decision to abstain, reported a
 * determination the model never made. An unknown outcome escalates (DEC-30).
 *
 * Typed so a caller can tell it from a transient failure. These calls run at
 * temperature 0, so the same prompt reproduces the same unreadable answer, and
 * a retry ceiling sized for a transient fault would spend a full pipeline run
 * per attempt.
 */
export class UnreadableAnswerError extends Error {
  constructor(
    message: string,
    /** Which way the answer failed to read, for the operator. */
    readonly shape: string,
    /**
     * What the faulting call cost, in micro-dollars (DEC-25).
     *
     * A truncated call exhausted its answer budget by definition, so it is the
     * most expensive call of a run. Throwing without it understated the run by
     * its largest single call.
     */
    readonly costMicros = 0,
    /**
     * True when the provider reported no cost for the faulting call.
     *
     * DEC-25 refuses to report a cost of zero as if it were measured. So the
     * run records that the spend is unknown rather than recording nothing:
     * an earlier attempt threw an untyped error here, which no caller could
     * tell from a protocol failure, and the run then never terminated at all.
     * A run that ends and says its spend is unknown beats a run that hangs.
     */
    readonly costUnknown = false,
  ) {
    super(message);
    this.name = 'UnreadableAnswerError';
  }
}

/**
 * The provider answered a call with an HTTP error status.
 *
 * Still untyped for the queue, which retries it like any transport failure
 * (DEC-30). The status is here for a caller that must tell a refusal of its
 * input from a fault of the service: 400 is this call's own, 503 is not.
 */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}
