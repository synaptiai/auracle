import type {
  ChatRequest,
  ChatResult,
  EmbeddingRequest,
  EmbeddingResult,
  ModelProvider,
  PinnedVersions,
} from './provider.js';

/** One scripted model response. Absent fields fall back to sane defaults. */
export interface FakeStep {
  text?: string;
  vectors?: number[][];
  costCents?: number;
  /** The served model id the step reports back. Defaults to the pinned id. */
  servedModelVer?: string;
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
    return {
      text: step.text ?? '',
      costCents: step.costCents ?? 1,
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
      costCents: step.costCents ?? 0,
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
