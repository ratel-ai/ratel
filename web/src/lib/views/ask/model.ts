import type Anthropic from "@anthropic-ai/sdk";
import { type Config, getConfig } from "@/config";
import { deploymentEnvironment } from "@/lib/platform/environment";
import { anthropicUsage, recordModelCall, trackModelCall } from "@/lib/platform/model-call";
import { anthropicContent } from "@/lib/platform/model-call-content";
import { anthropicClient, anthropicConfigured } from "@/lib/readings/anthropic/client";
import { wellFormedJson } from "@/lib/readings/text/well-formed";
import {
  estimateTokens,
  type ModelUsage,
  mockModelsEnabled,
  SpendMeter,
  STAND_IN_MODEL,
} from "@/lib/views/eval-gate/models";
import { ASK_ANSWER_SCHEMA, type AskRequest } from "./domain";
import { ASK_FEATURE, ASK_MAX_CALLS, ASK_MAX_TOKENS, ASK_MAX_WIDGETS, ASK_MODEL } from "./limits";

/**
 * The model of Ask in words, behind a port so the draft is tested with a fake one. The real one is
 * Claude Haiku through the deployment's Claude backend, each call reported through the model-call
 * seam under its own feature. With no backend there is no model. `EVAL_GATE_MOCK_MODEL=1` gives a
 * deterministic stand-in in local environments only, as the eval gate's models do.
 */

export interface AskModel {
  model: string;
  standIn: boolean;
  complete(request: AskRequest): Promise<{ text: string; usage: ModelUsage }>;
}

/** The model this deployment has for a draft, or null. */
export function askModelFromEnv(
  config: Pick<Config, "anthropic" | "evalGate"> = getConfig(),
  environment: string = deploymentEnvironment(),
): AskModel | null {
  if (mockModelsEnabled(config, environment)) return standInAskModel();
  const client = anthropicClient({ maxRetries: 1, timeout: 30_000 }, config);
  if (!client) return null;
  return {
    model: ASK_MODEL,
    standIn: false,
    async complete({ system, user }) {
      const request: Anthropic.MessageCreateParamsNonStreaming = {
        model: ASK_MODEL,
        max_tokens: ASK_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
        output_config: {
          format: { type: "json_schema", schema: ASK_ANSWER_SCHEMA },
          effort: "low",
        },
      };
      const message = await trackModelCall(
        {
          provider: "anthropic",
          model: ASK_MODEL,
          feature: ASK_FEATURE,
          payer: "ratel",
          content: anthropicContent(request),
        },
        () => client.messages.create(wellFormedJson(request)),
        anthropicUsage,
      );
      if (message.stop_reason === "refusal") throw new Error("The model refused the draft.");
      if (message.stop_reason === "max_tokens")
        throw new Error("The draft passed the output token limit.");
      return {
        text: message.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join(""),
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      };
    },
  };
}

/** Whether this deployment can draft: the local stand-in, or a Claude backend. The dialogs hide the ask field without it. */
export function askConfigured(
  config: Pick<Config, "anthropic" | "evalGate"> = getConfig(),
  environment: string = deploymentEnvironment(),
): boolean {
  return mockModelsEnabled(config, environment) || anthropicConfigured(config);
}

/** What a call of the model costs in USD: priced as the eval gate prices it. */
export function askCallUsd(model: string, usage: ModelUsage): number {
  return PRICER.price(model, usage);
}

/** The worst cost of one draft: every call of it with twice the request's estimated input. */
export function askReserveUsd(model: string, request: AskRequest): number {
  const inputTokens = 2 * estimateTokens(request.system, request.user);
  return ASK_MAX_CALLS * askCallUsd(model, { inputTokens, outputTokens: ASK_MAX_TOKENS });
}

/** A draft never made because no model key is configured, as one `model_call` line. */
export function recordNoAskKey(): void {
  recordModelCall({
    provider: "anthropic",
    model: ASK_MODEL,
    feature: ASK_FEATURE,
    payer: "ratel",
    outcome: "skipped_no_key",
    durationMs: 0,
    calls: 1,
  });
}

/** A draft a limit stopped before its call, as one `model_call` line. */
export function recordAskRefusal(model: AskModel): void {
  if (model.standIn) return;
  recordModelCall({
    provider: "anthropic",
    model: model.model,
    feature: ASK_FEATURE,
    payer: "ratel",
    outcome: "refused_budget",
    durationMs: 0,
    calls: 1,
  });
}

const PRICER = new SpendMeter(Number.POSITIVE_INFINITY);

/** Fixed widgets of the stand-in, the first ones first. */
const STAND_IN_WIDGETS = [
  {
    title: "Traces per hour",
    rql: "select time_bucket('1 hour', started_at) as hour, count(*) as traces from traces group by hour order by hour",
    chart: "line",
  },
  {
    title: "Cost by model",
    rql: "select model, sum(cost_usd) as cost from events where type = 'llm_call' group by model order by cost desc limit 10",
    chart: "bar",
  },
  {
    title: "Error rate",
    rql: "select rate(has_error) as error_rate from traces",
    chart: "number",
  },
  {
    title: "p95 latency per hour",
    rql: "select time_bucket('1 hour', started_at) as hour, p95(duration_ms) as p95_ms from traces group by hour order by hour",
    chart: "line",
  },
];

/** A deterministic model for tests and local demos: fixed widgets, as many as the target takes. */
export function standInAskModel(): AskModel {
  return {
    model: STAND_IN_MODEL,
    standIn: true,
    async complete({ user }) {
      const { target } = JSON.parse(user.split("\n")[0] ?? "{}") as {
        target?: "dashboard" | "widget";
      };
      const count = ASK_MAX_WIDGETS[target === "widget" ? "widget" : "dashboard"];
      return {
        text: JSON.stringify({ widgets: STAND_IN_WIDGETS.slice(0, count) }),
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}
