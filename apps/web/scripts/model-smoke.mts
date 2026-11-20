/**
 * A live check of the model kit against whatever provider the environment selects
 * (ADR-0033): one plain answer, one answer bound to a JSON schema, one streamed answer and one
 * tool call with its result fed back. It prints what came back and exits non-zero when a step
 * did not behave. Nothing is stored.
 *
 *   MODEL_PROVIDER=openai-compatible MODEL_BASE_URL=http://localhost:11434/v1 \
 *   MODEL_STANDARD=llama3.2:1b MODEL_DEEP=llama3.2:1b pnpm --filter @ratel/platform models:smoke
 */
import { models } from "@/lib/readings/models";

const failures: string[] = [];

function check(step: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${step}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  if (!ok) failures.push(step);
}

const text = models.text("workflow_label");
const chat = models.chat("eval_gate_replay");
if (!text || !chat) {
  console.error(
    "No model for this environment. Set MODEL_PROVIDER (and MODEL_BASE_URL, MODEL_STANDARD, MODEL_DEEP for openai-compatible), or a Claude key.",
  );
  process.exit(2);
}
console.log(`provider ${text.provider}; text model ${text.model}; chat model ${chat.model}`);

const plain = await text.complete({
  system: "You answer in one short sentence.",
  user: "What is the capital of France?",
  maxTokens: 100,
});
check("plain answer", plain.stop === "end" && /paris/i.test(plain.text), {
  text: plain.text,
  usage: plain.usage,
});

const SCHEMA = {
  type: "object",
  properties: {
    city: { type: "string" },
    country: { type: "string" },
  },
  required: ["city", "country"],
  additionalProperties: false,
};
const bound = await text.complete({
  system: "You extract facts as JSON.",
  user: "The Eiffel Tower is in Paris, France.",
  schema: SCHEMA,
  maxTokens: 200,
});
let parsed: Record<string, unknown> | null = null;
try {
  parsed = JSON.parse(bound.text);
} catch {
  parsed = null;
}
check(
  "JSON bound to a schema",
  parsed !== null && typeof parsed.city === "string" && typeof parsed.country === "string",
  { text: bound.text, usage: bound.usage },
);

const streamed = await text.complete({
  system: "You answer in one short sentence.",
  user: "Name three primary colours.",
  maxTokens: 200,
  longOutput: true,
});
check("streamed answer", streamed.stop === "end" && streamed.text.length > 0, {
  text: streamed.text,
  usage: streamed.usage,
});

const tools = [
  {
    name: "get_weather",
    description: "The current weather in a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "The city's name" } },
      required: ["city"],
    },
  },
];
const ask = { role: "user" as const, text: "What is the weather in Paris right now? Use the tool." };
const first = await chat.next({
  system: "You are a helpful assistant. Use the tools you are given.",
  tools,
  messages: [ask],
  maxTokens: 300,
});
check("tool call", first.calls.length > 0 && first.calls[0].name === "get_weather", {
  calls: first.calls,
  text: first.text,
});

if (first.calls.length > 0) {
  const second = await chat.next({
    system: "You are a helpful assistant. Use the tools you are given.",
    tools,
    messages: [
      ask,
      { role: "assistant", text: first.text, calls: first.calls, raw: first.raw },
      ...first.calls.map((call) => ({
        role: "tool" as const,
        callId: call.id,
        content: "18°C, light rain",
        isError: false,
      })),
    ],
    maxTokens: 300,
  });
  check("answer after the tool result", second.stop === "end" && second.text.length > 0, {
    text: second.text,
    usage: second.usage,
  });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} step(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall steps passed");
