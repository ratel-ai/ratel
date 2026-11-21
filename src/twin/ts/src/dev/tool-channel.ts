import type {
  ConfirmAnswer,
  ConfirmRequest,
  FakeAnswer,
  FakeRequest,
  ToolChannel,
} from "../tools.js";
import type { ToolAnswerType, ToolRequestType } from "./runs.js";

// The tool channel of one run inside the `ratel dev` child. A fake or confirm
// call becomes a tool.request to the parent, which sends it to the controller.
// The controller's answer comes back as tool.answer and settles the call.

type Send = (
  type: ToolRequestType,
  payload: { readonly callId: string } & Readonly<Record<string, unknown>>,
) => void;

interface Waiting {
  readonly type: ToolRequestType;
  resolve(payload: Readonly<Record<string, unknown>>): void;
  reject(err: Error): void;
}

const REQUEST_OF: Readonly<Record<ToolAnswerType, ToolRequestType>> = {
  "tool.fake.result": "tool.fake.request",
  "tool.confirm.decision": "tool.confirm.request",
};

export class IpcToolChannel implements ToolChannel {
  readonly #waiting = new Map<string, Waiting>();
  readonly #send: Send;

  constructor(send: Send) {
    this.#send = send;
  }

  async fake(request: FakeRequest, signal: AbortSignal): Promise<FakeAnswer> {
    const answer = await this.#ask("tool.fake.request", { ...request }, signal);
    return {
      result: answer.result,
      isError: answer.isError === true,
      source: (answer.source as FakeAnswer["source"]) ?? "generated",
    };
  }

  async confirm(request: ConfirmRequest, signal: AbortSignal): Promise<ConfirmAnswer> {
    const answer = await this.#ask("tool.confirm.request", { ...request }, signal);
    return {
      decision: answer.decision as ConfirmAnswer["decision"],
      ...("args" in answer ? { args: answer.args } : {}),
      ...("result" in answer ? { result: answer.result } : {}),
    };
  }

  /** The controller's answer. One that nobody waits for is dropped. */
  answer(type: ToolAnswerType, payload: Readonly<Record<string, unknown>>): void {
    const callId = typeof payload.callId === "string" ? payload.callId : "";
    const waiting = this.#waiting.get(callId);
    if (!waiting || waiting.type !== REQUEST_OF[type]) return;
    this.#waiting.delete(callId);
    waiting.resolve(payload);
  }

  /** The run ended: every call still waiting fails. */
  close(reason: Error): void {
    for (const waiting of this.#waiting.values()) waiting.reject(reason);
    this.#waiting.clear();
  }

  #ask(
    type: ToolRequestType,
    payload: { readonly callId: string } & Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        return;
      }
      const onAbort = () => {
        this.#waiting.delete(payload.callId);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiting.set(payload.callId, {
        type,
        resolve: (answer) => {
          signal.removeEventListener("abort", onAbort);
          resolve(answer);
        },
        reject: (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
      this.#send(type, payload);
    });
  }
}
