import type {
  ChatRequest,
  ChatResult,
  EmbeddingRequest,
  EmbeddingResult,
  ModelProvider,
  PinnedVersions,
} from './provider.js';
import { UnreadableAnswerError } from './provider.js';

/** One scripted model response. Absent fields fall back to sane defaults. */
/** One cent, in micro-dollars. The fake bills a chat call this much. */
export const ONE_CENT_IN_MICROS = 10_000;

export interface FakeStep {
  text?: string;
  vectors?: number[][];
  /** Micro-dollars for this step. Defaults to one cent for a chat call. */
  costMicros?: number;
  /** The served model id the step reports back. Defaults to the pinned id. */
  servedModelVer?: string;
  /**
   * Why the model stopped. 'length' means the answer budget ran out, which
   * the real provider reports and refuses. Absent means it stopped on its own.
   *
   * The fake modelled no stop reason at all, so every consumer test drove the
   * truncation guard with an empty string instead of a truncated answer. That
   * is why an ordering defect in the guard was invisible to the whole suite.
   */
  finishReason?: string;
  /** The provider reported no cost for this call. Only meaningful with finishReason. */
  costUnknown?: boolean;
  /** Which way the answer failed, when the step models a refusal. */
  shape?: string;
}

/** A recorded call, for assertions in tests. */
export interface RecordedCall {
  kind: 'chat' | 'embed';
  messages?: ChatRequest['messages'];
  input?: EmbeddingRequest['input'];
  temperature?: number;
  maxOutputTokens?: number;
  promptVer: string;
  modelVer: string;
  dataGuaranteeZdrOnly: boolean | undefined;
}

/**
 * Scripted provider for tests. No network, no model. Each complete()/embed()
 * consumes the next script entry in order and records the call. An exhausted
 * script throws instead of inventing output.
 */
export class FakeProvider implements ModelProvider {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly script: FakeStep[] = [],
    private readonly defaultZdrOnly?: boolean,
  ) {}

  async complete(
    call: ChatRequest & PinnedVersions & { dataGuarantee?: { zdrOnly?: boolean } },
  ): Promise<ChatResult> {
    const step = this.next('chat');
    const record: RecordedCall = {
      kind: 'chat',
      messages: call.messages,
      temperature: call.temperature,
      promptVer: call.promptVer,
      modelVer: call.modelVer,
      dataGuaranteeZdrOnly:
        call.dataGuarantee?.zdrOnly ?? this.defaultZdrOnly,
    };
    if (call.maxOutputTokens !== undefined) {
      record.maxOutputTokens = call.maxOutputTokens;
    }
    this.calls.push(record);
    if (step.finishReason === 'length') {
      // Billed, like the real provider bills it: the call exhausted its budget.
      throw new UnreadableAnswerError(
        `the model stopped at the answer budget of ${String(call.maxOutputTokens ?? 'unset')} `
          + `tokens for ${call.modelVer}; the answer is incomplete and is not a result`,
        step.shape ?? 'truncated',
        step.costUnknown === true ? 0 : step.costMicros ?? ONE_CENT_IN_MICROS,
        step.costUnknown === true,
      );
    }
    return {
      text: step.text ?? '',
      costMicros: step.costMicros ?? ONE_CENT_IN_MICROS,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      servedModelVer: step.servedModelVer ?? call.modelVer,
    };
  }

  async embed(
    call: EmbeddingRequest &
      PinnedVersions & { dataGuarantee?: { zdrOnly?: boolean } },
  ): Promise<EmbeddingResult> {
    const step = this.next('embed');
    if (step.finishReason === 'length' || step.shape !== undefined) {
      // An embed the retriever cannot read. Without this the fake had no
      // throw path at all, so the coordinator's retrieve catch was
      // unreachable and a test written for it landed on a different branch.
      throw new UnreadableAnswerError(
        `the embedder returned something this run cannot read for ${call.modelVer}`,
        step.shape ?? 'truncated',
        step.costUnknown === true ? 0 : step.costMicros ?? 0,
        step.costUnknown === true,
      );
    }
    this.calls.push({
      kind: 'embed',
      input: call.input,
      promptVer: call.promptVer,
      modelVer: call.modelVer,
      dataGuaranteeZdrOnly:
        call.dataGuarantee?.zdrOnly ?? this.defaultZdrOnly,
    });
    return {
      vectors: step.vectors ?? call.input.map(() => []),
      costMicros: step.costMicros ?? 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      servedModelVer: step.servedModelVer ?? call.modelVer,
    };
  }

  private next(kind: 'chat' | 'embed'): FakeStep {
    const step = this.script.shift();
    if (step === undefined) {
      throw new Error(`FakeProvider script is exhausted at a ${kind} call`);
    }
    return step;
  }
}
