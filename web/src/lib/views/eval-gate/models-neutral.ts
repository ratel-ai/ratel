import { extractModelJsonObject } from "@/lib/catalog/skills/model-json";
import type { TextRequest } from "@/lib/contracts/models";
import {
  type ChatFeatureId,
  type ModelOptions,
  models,
  replaysModel,
  type TextFeatureId,
} from "@/lib/readings/models";
import { ModelHttpError } from "@/lib/readings/models/providers/http";
import {
  AGENT_MAX_TOKENS,
  type AgentContext,
  type AgentModel,
  JUDGE_SCHEMA,
  JUDGE_SYSTEM,
  type JudgeModel,
  judgePrompt,
  ModelRefused,
  PERSON_SYSTEM,
  type PersonModel,
  personPrompt,
  readVerdict,
  SMALL_MAX_TOKENS,
  STAND_IN_SYSTEM,
  standInPrompt,
  TEST_DRAFT_PROMPT,
  type TestDraftModel,
  type ToolStandIn,
} from "@/lib/views/eval-gate/models";

/**
 * The eval gate's models on a vendor whose model is not Claude (ADR-0009 §11): the same
 * interfaces, prompts and limits as the Claude code in `models.ts`, over the model kit. Each is
 * null when the deployment has no model for it.
 */

type Options = Pick<ModelOptions, "config" | "environment">;
type SmallOptions = Options & Pick<ModelOptions, "model">;

/** Turns a refused key into `ModelRefused`, as the Claude code does: no further call can succeed. */
async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ModelHttpError && (error.status === 401 || error.status === 403))
      throw new ModelRefused();
    throw error;
  }
}

/**
 * The run's own model when the vendor serves it, else the vendor's. A model the vendor no longer
 * serves (404) falls back to the vendor's for the rest of the run; the reply says which answered.
 */
export function neutralAgent(
  feature: ChatFeatureId,
  options: Options,
  override?: string,
): ((context: AgentContext) => AgentModel | null) | null {
  const fallback = models.chat(feature, options);
  if (!fallback) return null;
  return ({ recordedModel }) => {
    const asked =
      override ??
      (recordedModel && replaysModel(recordedModel, options) ? recordedModel : fallback.model);
    let current = models.chat(feature, { ...options, model: asked }) ?? fallback;
    return {
      model: current.model,
      provider: current.provider,
      standIn: false,
      async next({ system, tools, messages }) {
        const started = Date.now();
        const request = {
          ...(system ? { system } : {}),
          tools,
          messages,
          maxTokens: AGENT_MAX_TOKENS,
          effort: "low" as const,
        };
        const reply = await guarded(async () => {
          try {
            return await current.next(request);
          } catch (error) {
            const gone = error instanceof ModelHttpError && error.status === 404;
            if (!gone || current.model === fallback.model) throw error;
            current = fallback;
            return current.next(request);
          }
        });
        if (reply.stop === "refused") throw new Error("the replay model declined the request");
        return {
          text: reply.text,
          calls: reply.calls,
          raw: reply.raw,
          usage: reply.usage,
          latencyMs: Date.now() - started,
          // The model asked for: prices and the page name it, not the server's own spelling.
          model: current.model,
        };
      },
    };
  };
}

function small(feature: TextFeatureId, options: SmallOptions) {
  const text = models.text(feature, options);
  if (!text) return null;
  return {
    identity: { model: text.model, provider: text.provider, standIn: false as const },
    ask: (request: Pick<TextRequest, "system" | "user" | "schema" | "effort">) =>
      guarded(() => text.complete({ ...request, maxTokens: SMALL_MAX_TOKENS })),
  };
}

export function neutralToolStandIn(options: Options): ToolStandIn | null {
  const model = small("eval_gate_stand_in", options);
  if (!model) return null;
  return {
    ...model.identity,
    async answer(input) {
      const reply = await model.ask({
        system: STAND_IN_SYSTEM,
        user: standInPrompt(input),
        effort: "low",
      });
      const content = reply.text.trim() || "{}";
      return { content, isError: /"error"\s*:/.test(content), usage: reply.usage };
    },
  };
}

export function neutralPerson(options: Options): PersonModel | null {
  const model = small("eval_gate_stand_in", options);
  if (!model) return null;
  return {
    ...model.identity,
    async write(input) {
      const reply = await model.ask({
        system: PERSON_SYSTEM,
        user: personPrompt(input),
        effort: "low",
      });
      if (reply.stop === "refused") throw new Error("the simulated person declined the request");
      return { text: reply.text.trim(), usage: reply.usage };
    },
  };
}

/**
 * `feature` names the spend line. `modelOf` is the feature whose model answers: a task's eval is
 * judged on the judge's own model under the task's feature, as the Claude code does.
 */
export function neutralJudge(
  feature: "eval_gate_judge" | "eval_gate_task_judge",
  options: Options,
  modelOf: "eval_gate_judge" | "eval_gate_task_judge" = feature,
): JudgeModel | null {
  const asked = modelOf === feature ? undefined : models.text(modelOf, options)?.model;
  if (modelOf !== feature && !asked) return null;
  const model = small(feature, asked ? { ...options, model: asked } : options);
  if (!model) return null;
  return {
    ...model.identity,
    async judge(input) {
      const reply = await model.ask({
        system: JUDGE_SYSTEM,
        user: judgePrompt(input),
        schema: JUDGE_SCHEMA,
        effort: "low",
      });
      if (reply.stop === "refused") throw new Error("the judge declined the request");
      // A server without schemas may wrap its answer in words or a code fence.
      return { pass: readVerdict(extractModelJsonObject(reply.text)), usage: reply.usage };
    },
  };
}

export function neutralTestDraft(options: Options): TestDraftModel | null {
  const model = small("eval_gate_task_test_draft", options);
  if (!model) return null;
  return {
    ...model.identity,
    async draft(input) {
      const reply = await model.ask({ system: TEST_DRAFT_PROMPT, user: input });
      return { text: reply.text, usage: reply.usage };
    },
  };
}
