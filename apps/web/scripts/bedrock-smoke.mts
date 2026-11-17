/**
 * Live calls to Bedrock through `anthropicClient`, on made-up text: checks model
 * access, the EU profiles, and each request shape the app sends (plain text,
 * structured output with effort, streaming, a tool call and its reply with the
 * model's own blocks passed back). Reads no database and sends no customer data.
 * Spends a few small calls per model.
 *
 *   AWS_PROFILE=ratel-cloud-staging pnpm --filter @ratel/cloud bedrock:smoke [--models claude-haiku-5-5,claude-sonnet-5-5]
 *
 * Uses the AWS credential chain. Exits 1 when any call fails.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicClient, type AnthropicClient } from "@/lib/readings/anthropic/client";

type Check = (client: AnthropicClient, model: string) => Promise<string>;

const DEFAULT_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

const MAX_TOKENS = 2048;

const VERDICT_SCHEMA = {
  type: "object",
  properties: { pass: { type: "boolean" } },
  required: ["pass"],
  additionalProperties: false,
};

const WEATHER_TOOL: Anthropic.Tool = {
  name: "get_weather",
  description: "Read the weather in one city.",
  input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

const CHECKS: Record<string, Check> = { text, structured, stream, tools };

const client = anthropicClient({ maxRetries: 0 }, { ANTHROPIC_BACKEND: "bedrock", AWS_BEARER_TOKEN_BEDROCK: process.env.AWS_BEARER_TOKEN_BEDROCK });
if (!client) throw new Error("No Bedrock client: unset AWS_BEARER_TOKEN_BEDROCK");

let failed = 0;
for (const model of modelsFromArgs()) {
  for (const [name, check] of Object.entries(CHECKS)) {
    const started = Date.now();
    try {
      const detail = await check(client, model);
      console.log(`ok    ${model}  ${name}  ${Date.now() - started}ms  ${detail}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${model}  ${name}  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
console.log(failed === 0 ? "All calls passed." : `${failed} calls failed.`);
process.exit(failed === 0 ? 0 : 1);

function modelsFromArgs(): string[] {
  const index = process.argv.indexOf("--models");
  return index === -1 ? DEFAULT_MODELS : (process.argv[index + 1] ?? "").split(",").filter(Boolean);
}

async function text(api: AnthropicClient, model: string): Promise<string> {
  const message = await api.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: "Reply with the single word ok." }],
  });
  return `${message.stop_reason}: ${textOf(message)}`;
}

/** The shape of the judge, the topic namer and the fix drafts. */
async function structured(api: AnthropicClient, model: string): Promise<string> {
  const message = await api.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: "Is 2 + 2 equal to 4? Answer in the requested format." }],
    output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA }, effort: "low" },
  });
  const verdict = JSON.parse(textOf(message)) as { pass: boolean };
  if (verdict.pass !== true) throw new Error(`unexpected verdict ${textOf(message)}`);
  return `${message.stop_reason}: ${textOf(message)}`;
}

/** The shape of the match-quality analyst. */
async function stream(api: AnthropicClient, model: string): Promise<string> {
  const message = await api.messages
    .stream({
      model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: "Is 2 + 2 equal to 4? Answer in the requested format." }],
      output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA }, effort: "low" },
    })
    .finalMessage();
  JSON.parse(textOf(message));
  return `${message.stop_reason}: ${textOf(message)}, ${message.usage.input_tokens}+${message.usage.output_tokens} tokens`;
}

/** The shape of a replay: a tool call, then its result with the model's blocks passed back unchanged. */
async function tools(api: AnthropicClient, model: string): Promise<string> {
  const ask: Anthropic.MessageParam = { role: "user", content: "Use the tool to read the weather in Rome, then say it in one word." };
  const first = await api.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    tools: [WEATHER_TOOL],
    tool_choice: { type: "auto" },
    messages: [ask],
  });
  const call = first.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!call) throw new Error(`no tool call, stop reason ${first.stop_reason}`);
  const second = await api.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    tools: [WEATHER_TOOL],
    tool_choice: { type: "auto" },
    messages: [
      ask,
      { role: "assistant", content: first.content as Anthropic.ContentBlockParam[] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "sunny" }] },
    ],
  });
  return `${second.stop_reason}: ${textOf(second)}`;
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
