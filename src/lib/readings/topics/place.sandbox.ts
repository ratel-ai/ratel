import { sandbox } from "@ratel-ai/sandbox";
import { resolveDecisionEngine } from "@/lib/readings/decisions/engine";
import { topicJudgeFromEnv } from "@/lib/readings/topics/job";
import {
  askCases,
  chosenOption,
  type PlaceableTopic,
  TOPIC_SANDBOX_ID,
  topicDefaults,
  topicOptions,
} from "@/lib/readings/topics/place";

/**
 * The `topic-place` sandbox (RC-1092): the `assign_topics` job's one placement,
 * one ask and the topic options in, the chosen topic or none out, on a
 * decision engine. The model is `engine/model` (`openai/<decisions model>`)
 * and resolves through the decision engine, not the provider map. `ratel sandbox run` and `ratel sandbox dev` load it; no
 * production code imports it.
 *
 *   ratel sandbox run topic-place --input lib/readings/topics/place.sandbox.input.json --set minConfidence=0.99
 */

export interface TopicPlaceInput {
  ask: string;
  topics: PlaceableTopic[];
}

export interface TopicPlaceOutput {
  /** The chosen topic's id, or null for none (declined, below the threshold, or "none of these"). */
  topicId: string | null;
  confidence: number | null;
}

/** A resolved model param: which decision engine, and its bare model. */
export interface DecisionModel {
  engine: DecisionModelEngine;
  model: string;
}

/**
 * Owned (ADR-0030): OpenAI is the one decision engine here (`readings/decisions/engine.ts`);
 * upstream also lists its private engines and their keys.
 */
type DecisionModelEngine = "openai";

/** The key each engine runs with (lib/readings/decisions/engine.ts). */
const ENGINE_KEY: Record<DecisionModelEngine, string> = {
  openai: "OPENAI_API_KEY",
};

const TOPIC = {
  type: "object",
  required: ["topicId", "name", "description"],
  additionalProperties: false,
  properties: {
    topicId: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
  },
} as const;

/** JSON Schema of {@link TopicPlaceInput}. */
export const TopicPlaceInputSchema = {
  type: "object",
  required: ["ask", "topics"],
  additionalProperties: false,
  properties: {
    ask: { type: "string", minLength: 1 },
    topics: { type: "array", minItems: 1, items: TOPIC },
  },
} as const;

export default sandbox(TOPIC_SANDBOX_ID, {
  params: {
    model: sandbox.model(topicDefaults.model),
    about: sandbox.prompt(topicDefaults.about),
    question: sandbox.prompt(topicDefaults.question),
    minConfidence: sandbox.number(topicDefaults.minConfidence, { min: 0, max: 1 }),
  },
  input: sandbox.structured<TopicPlaceInput>(TopicPlaceInputSchema),
  resolve: resolveDecisionModel,
  run: async ({ input, params }): Promise<TopicPlaceOutput> => {
    const env = {
      ...process.env,
      DECISION_ENGINE: params.model.engine,
      DECISION_ENGINE_FALLBACK: "off",
    };
    if (resolveDecisionEngine(env)?.name !== params.model.engine) {
      throw new Error(`no ${params.model.engine} key: set ${ENGINE_KEY[params.model.engine]}`);
    }
    const judge = topicJudgeFromEnv(
      { about: params.about, question: params.question },
      env,
      "topics_place",
      {
        model: params.model.model,
        minConfidence: params.minConfidence,
      },
    );
    if (!judge) throw new Error(`the ${params.model.engine} engine is not configured`);
    const [verdict] = await judge.judge(
      askCases([{ hash: "ask", text: input.ask }]),
      topicOptions(input.topics),
    );
    return {
      topicId: chosenOption(verdict, new Set(input.topics.map((topic) => topic.topicId))),
      confidence: verdict?.confidence ?? null,
    };
  },
});

/** `openai/gpt-6-luna` → `{ engine: "openai", model: "gpt-6-luna" }`. Any other engine is refused. */
export function resolveDecisionModel(id: string): DecisionModel {
  const slash = id.indexOf("/");
  const engine = id.slice(0, slash);
  if (slash < 1 || !Object.hasOwn(ENGINE_KEY, engine))
    throw new TypeError(`"${id}" is not an openai/ model`);
  return { engine: engine as DecisionModelEngine, model: id.slice(slash + 1) };
}
