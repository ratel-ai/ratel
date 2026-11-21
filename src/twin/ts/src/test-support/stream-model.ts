// A local AI SDK model (specification v2, accepted by ai@6 and ai@7) that
// streams canned text pieces and records the prompt of each call. Not
// `ai/test`: its class name changes per major. Build-excluded.

export interface StreamCall {
  readonly prompt: unknown[];
}

export class StreamModel {
  readonly specificationVersion = "v2";
  readonly provider = "mock-provider";
  readonly supportedUrls = {};
  readonly calls: StreamCall[] = [];

  constructor(
    readonly modelId: string,
    private readonly pieces: readonly string[],
  ) {}

  async doGenerate(): Promise<never> {
    throw new Error("StreamModel only streams");
  }

  async doStream(options: StreamCall): Promise<{ stream: ReadableStream<unknown> }> {
    this.calls.push(options);
    const parts: unknown[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      ...this.pieces.map((delta) => ({ type: "text-delta", id: "t1", delta })),
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
    ];
    return {
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    };
  }
}
