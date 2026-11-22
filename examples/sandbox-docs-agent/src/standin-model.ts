// DEMO ONLY (proof/rc-1200): a scripted stand-in for the model, for the hosted
// sandbox proof run without a model key. It makes no network call. Step 1 calls
// searchDocs with the user's words, step 2 calls createTicket, step 3 answers
// with the ticket id from the tool result. The tools run for real (searchDocs
// reads the bundled docs, createTicket writes to the sidecar Postgres).
// It is on only when DOCS_AGENT_STANDIN_MODEL=1 (a project secret in the demo).
import type { LanguageModel } from "ai";

type Part = Record<string, unknown>;
interface Message {
  readonly role?: string;
  readonly content?: unknown;
}
interface CallOptions {
  readonly prompt?: readonly Message[];
}

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** The resolver: the stand-in when DOCS_AGENT_STANDIN_MODEL=1, else `real`. */
export function standinOr<R extends object>(real: R, env: NodeJS.ProcessEnv = process.env): R {
  if (env.DOCS_AGENT_STANDIN_MODEL !== "1") return real;
  const resolve = (modelId: string) => new StandinModel(modelId) as unknown as LanguageModel;
  return Object.assign(resolve, {
    modelKind: "language-model" as const,
    // The runner checks the model's provider prefix against this list: the stand-in takes any of them.
    callableProviders: () =>
      ["standin", "anthropic", "openai", "google", "amazon-bedrock"].map((provider) => ({
        provider,
        keys: [],
      })),
  }) as unknown as R;
}

class StandinModel {
  readonly specificationVersion = "v3";
  readonly provider = "ratel-demo-standin";
  readonly supportedUrls = {};
  readonly modelId: string;

  constructor(requested: string) {
    this.modelId = `standin (scripted, for ${requested})`;
  }

  async doGenerate(options: CallOptions) {
    const content = script(options);
    return { content, finishReason: finishOf(content), usage: USAGE, warnings: [] };
  }

  async doStream(options: CallOptions) {
    const content = script(options);
    const parts: Part[] = [{ type: "stream-start", warnings: [] }];
    for (const item of content) {
      if (item.type !== "text") {
        parts.push(item);
        continue;
      }
      parts.push({ type: "text-start", id: "t1" });
      for (const word of String(item.text).split(/(?<= )/))
        parts.push({ type: "text-delta", id: "t1", delta: word });
      parts.push({ type: "text-end", id: "t1" });
    }
    parts.push({ type: "finish", finishReason: finishOf(content), usage: USAGE });
    let i = 0;
    return {
      stream: new ReadableStream<Part>({
        async pull(controller) {
          if (i >= parts.length) return controller.close();
          await new Promise((r) => setTimeout(r, 70));
          controller.enqueue(parts[i++] as Part);
        },
      }),
    };
  }
}

function script(options: CallOptions): Part[] {
  const prompt = options.prompt ?? [];
  const results = prompt
    .filter((m) => m.role === "tool")
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as Part[]) : []));
  const ticket = results.find((r) => r.toolName === "createTicket");
  if (ticket) {
    const value = (ticket.output as { value?: { ticketId?: string } } | undefined)?.value;
    const id = value?.ticketId ?? "unknown";
    return [
      {
        type: "text",
        text: `I could not find a fix for this in the docs, so I opened support ticket ${id} for you. The Ratel team will answer there. (Stand-in model: this answer is scripted, no LLM was called.)`,
      },
    ];
  }
  const userText = lastUserText(prompt);
  if (results.some((r) => r.toolName === "searchDocs"))
    return [
      call("call_2", "createTicket", {
        title: "401 when sending traces",
        body: `From the docs agent chat: ${userText}`.slice(0, 500),
      }),
    ];
  return [call("call_1", "searchDocs", { query: userText.slice(0, 120) || "api key 401" })];
}

function call(toolCallId: string, toolName: string, input: unknown): Part {
  return { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) };
}

function lastUserText(prompt: readonly Message[]): string {
  const user = [...prompt].reverse().find((m) => m.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  if (!Array.isArray(user.content)) return "";
  return (user.content as Part[])
    .filter((p) => p.type === "text")
    .map((p) => String(p.text))
    .join(" ");
}

function finishOf(content: readonly Part[]) {
  const reason = content.some((c) => c.type === "tool-call") ? "tool-calls" : "stop";
  return { unified: reason, raw: reason };
}
