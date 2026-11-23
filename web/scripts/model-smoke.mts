/**
 * A live check of whatever the environment selects (ADR-0009): one plain answer, one answer bound
 * to a JSON schema, one streamed answer, one tool call with its result fed back, one decision, and
 * embeddings when they have their own settings.
 * A kind the environment selects nothing for is skipped. It exits non-zero when a step did not
 * behave. Nothing is stored. It costs a few cents on a hosted vendor.
 *
 *   MODEL_PROVIDER=ollama MODEL_BASE_URL=http://localhost:11434 MODEL_STANDARD=llama3.2:1b \
 *   pnpm --filter @ratel/platform models:smoke
 */
import { getConfig } from "@/config";
import { embeddingProviderFromConfig } from "@/lib/adapters/oss/embedding-provider";
import type { TextModel } from "@/lib/contracts/models";
import { resolveDecisionEngine } from "@/lib/readings/decisions/engine";
import { judgeFromConfig } from "@/lib/readings/decisions/resolve";
import { models } from "@/lib/readings/models";
import { embedTexts } from "@/lib/synthesis/playground/embed";
import { type AgentModel, resolveEvalModels } from "@/lib/views/eval-gate/models";

const failures: string[] = [];

function check(step: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${step}: ${JSON.stringify(detail)}`);
  if (!ok) failures.push(step);
}

async function checkText(text: TextModel): Promise<void> {
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
}

async function checkAgent(agent: AgentModel): Promise<void> {
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
  const first = await agent.next({
    system: "You are a helpful assistant. Use the tools you are given.",
    tools,
    messages: [ask],
  });
  check("tool call", first.calls.length > 0 && first.calls[0].name === "get_weather", {
    calls: first.calls,
    text: first.text,
  });

  if (first.calls.length > 0) {
    const second = await agent.next({
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
    });
    check("answer after the tool result", second.text.length > 0, {
      text: second.text,
      usage: second.usage,
    });
  }
}

async function checkDecision(): Promise<void> {
  const judge = judgeFromConfig(undefined, { feature: "match_quality_judge" });
  const entry = (id: string, description: string) => ({
    entryId: id,
    name: id,
    searchable: description,
    description,
    source: "runtime" as const,
    matchesAgentDescription: false,
    tags: [],
  });
  const verdicts = await judge?.judge(
    [
      {
        id: "1",
        query: "I was charged twice, give me my money back",
        shortlist: [],
        assumed: "",
        stratum: "disputed",
      },
    ],
    [
      entry("create_charge", "Create a charge on a card"),
      entry("refund_payment", "Refund a payment, return the money to the customer"),
      entry("list_charges", "List charges"),
    ],
  );
  const verdict = verdicts?.[0];
  // Below its threshold the judge abstains, and its leaning is the runner-up: the vendor answered,
  // but a feature would leave this one undecided.
  const leaning = verdict?.entryId || verdict?.runnerUp;
  const step = verdict && !verdict.entryId ? "decision (undecided, below its threshold)" : "decision";
  check(step, leaning === "refund_payment", verdict ?? "no verdict");
}

async function checkEmbeddings(): Promise<void> {
  const provider = embeddingProviderFromConfig();
  const result = await embedTexts(
    [
      "give me my money back",
      "Refund a payment, return the money to the customer",
      "Assign a support ticket to a teammate",
    ],
    { provider },
  );
  if (!result.ok) return check("embeddings", false, result);
  const [query, refund, ticket] = result.vectors;
  const cosine = (a: number[], b: number[]) => {
    const dot = (x: number[], y: number[]) => x.reduce((sum, v, i) => sum + v * y[i], 0);
    return dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b));
  };
  const near = cosine(query, refund);
  const far = cosine(query, ticket);
  check("embeddings", !result.local && near > far, {
    model: provider.model,
    dimensions: query.length,
    near: Number(near.toFixed(3)),
    far: Number(far.toFixed(3)),
  });
}

const text = models.text("workflow_label");
const agent = resolveEvalModels().agent?.({ recordedModel: null, recorded: [] }) ?? null;
const decisions = resolveDecisionEngine();
const { embeddings } = getConfig();
const ownEmbeddings = Boolean(embeddings.baseUrl || embeddings.apiKey);
if (!text && !decisions && !ownEmbeddings) {
  console.error(
    "Nothing to check: name a vendor in MODEL_PROVIDER or DECISION_PROVIDER, or set EMBEDDING_BASE_URL.",
  );
  process.exit(2);
}
if (text) {
  console.log(`text: ${text.provider}, ${text.model}`);
  await checkText(text);
}
if (agent) {
  console.log(`agent: ${agent.provider ?? "anthropic"}, ${agent.model}`);
  await checkAgent(agent);
}
if (decisions) {
  console.log(`decisions: ${decisions.name}, ${decisions.model ?? "its default model"}`);
  await checkDecision();
}

if (ownEmbeddings) await checkEmbeddings();

if (failures.length > 0) {
  console.error(`\n${failures.length} step(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall steps passed");
