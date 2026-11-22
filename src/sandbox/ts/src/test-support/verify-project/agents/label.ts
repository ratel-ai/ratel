import { trace } from "@opentelemetry/api";

// The "real" code of the verify fixture: a raw-client agent. `complete` stands
// in for an Anthropic SDK call with GenAI instrumentation: it records a `chat`
// span with the request model and max tokens, and the system prompt only when
// content capture is on. No network call.

export const labelDefaults = {
  model: "anthropic/claude-sonnet-5-5",
  system: "You name agent workflows in three words.",
  maxTokens: 400,
};

export interface LabelInput {
  workflowId: string;
  toolOrder: string[];
}

export interface LabelConfig {
  model: string;
  system: string;
  maxTokens: number;
}

export async function label(input: LabelInput, cfg: LabelConfig): Promise<{ name: string }> {
  const user = `Workflow ${input.workflowId}: ${input.toolOrder.join(" -> ")}`;
  return { name: await complete(cfg, user) };
}

async function complete(cfg: LabelConfig, user: string): Promise<string> {
  return trace.getTracer("fixture-anthropic").startActiveSpan(`chat ${cfg.model}`, (span) => {
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": cfg.model,
      "gen_ai.request.max_tokens": cfg.maxTokens,
    });
    if (captureOn()) {
      span.setAttribute(
        "gen_ai.system_instructions",
        JSON.stringify([{ type: "text", content: cfg.system }]),
      );
      span.setAttribute(
        "gen_ai.input.messages",
        JSON.stringify([{ role: "user", parts: [{ type: "text", content: user }] }]),
      );
    }
    span.end();
    return `Refund lookup flow (${user.length} chars)`;
  });
}

function captureOn(): boolean {
  const mode = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ?? "";
  return mode !== "" && mode.toUpperCase() !== "NO_CONTENT" && mode.toLowerCase() !== "false";
}
