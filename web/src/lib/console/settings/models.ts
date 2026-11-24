import { type Config, getConfig } from "@/config";
import { embeddingProviderFromConfig } from "@/lib/adapters/oss/embedding-provider";
import { deploymentEnvironment } from "@/lib/platform/environment";
import { choiceClient } from "@/lib/readings/decisions/choice";
import { resolveDecisionEngine } from "@/lib/readings/decisions/engine";
import { decisionClient } from "@/lib/readings/decisions/openai";
import { models } from "@/lib/readings/models";
import {
  explainDecisionSetup,
  explainEmbeddingSetup,
  explainModelError,
  explainTextSetup,
  type KindSetup,
  type TextSetup,
} from "@/lib/readings/models/explain";
import type { ModelFailureRow } from "@/lib/readings/models/schema";
import { dbModelFailureStore } from "@/lib/readings/models/status";

/**
 * Organization settings > Models (ADR-0009 §13): which vendor and model each kind and feature
 * runs on, or why none does; each feature's last failure; and a check that asks each kind once.
 * Read-only: the models are chosen in the environment. The open-source edition's page.
 */

/** The edition whose deployment's models the page shows: another edition has its own. */
export const OSS_EDITION = "Ratel OSS";

export interface ModelSettings {
  text: TextSetup;
  decisions: KindSetup;
  embeddings: KindSetup;
  /** The last failure of each feature, by feature id. */
  failures: Record<string, ModelFailureRow>;
  /** The failures could not be read; the rest of the page still can. */
  failuresUnreadable: boolean;
}

export interface ModelSettingsOptions {
  config?: Config;
  environment?: string;
  failures?: () => Promise<ModelFailureRow[]>;
}

export async function loadModelSettings(
  options: ModelSettingsOptions = {},
): Promise<ModelSettings> {
  const config = options.config ?? getConfig();
  const environment = options.environment ?? deploymentEnvironment();
  const read = options.failures ?? (() => dbModelFailureStore().list());
  let rows: ModelFailureRow[] = [];
  let failuresUnreadable = false;
  try {
    rows = await read();
  } catch {
    failuresUnreadable = true;
  }
  return {
    text: explainTextSetup(config, environment),
    decisions: explainDecisionSetup(config),
    embeddings: explainEmbeddingSetup(config),
    failures: Object.fromEntries(rows.map((row) => [row.feature, row])),
    failuresUnreadable,
  };
}

export interface ModelCheck {
  kind: "text" | "decision" | "embedding";
  /** null: nothing to call. */
  ok: boolean | null;
  message: string;
  model?: string;
  ms?: number;
}

export interface CheckOptions {
  config?: Config;
  environment?: string;
  fetch?: typeof fetch;
}

/** The feature each check's call is counted under. */
const TEXT_FEATURE = "workflow_label";
const DECISION_FEATURE = "decision";
/** Embeddings have no row in the feature table: they are not a model call the kit makes. */
const EMBEDDINGS = "embeddings";

const CHECK_TIMEOUT_MS = 30_000;

async function timed<T>(call: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await call();
  return { value, ms: Date.now() - started };
}

async function checkText(config: Config, environment: string): Promise<ModelCheck> {
  const setup = explainTextSetup(config, environment);
  if (!setup.on) return { kind: "text", ok: null, message: setup.reason ?? "No text model." };
  const model = models.text(TEXT_FEATURE, { config, environment });
  if (!model)
    return {
      kind: "text",
      ok: null,
      message:
        setup.features.find((row) => row.feature === TEXT_FEATURE)?.reason ?? "No text model.",
    };
  try {
    const { ms } = await timed(() =>
      model.complete({
        system: "Answer with one word.",
        user: "Reply with OK.",
        maxTokens: 16,
        maxRetries: 0,
        timeoutMs: CHECK_TIMEOUT_MS,
      }),
    );
    return { kind: "text", ok: true, model: model.model, ms, message: `${model.model} answered.` };
  } catch (error) {
    return {
      kind: "text",
      ok: false,
      model: model.model,
      message: explainModelError(
        { feature: TEXT_FEATURE, model: model.model, error, kind: "text" },
        { config, environment },
      ),
    };
  }
}

const OPTIONS = [
  { id: "refund_payment", does: "Refund a payment, returning the money to the customer" },
  { id: "create_ticket", does: "Open a support ticket" },
];
const FRAMING = {
  about: "An AI agent typed this query into a tool search to find the tool it will call next.",
  question: "Which tool should the agent call next to do what this search query asks?",
};

async function checkDecision(config: Config, environment: string, fetchImpl?: typeof fetch) {
  const resolved = resolveDecisionEngine(config);
  if (!resolved) {
    const reason = explainDecisionSetup(config).reason ?? "No decision model.";
    return { kind: "decision", ok: null, message: reason } satisfies ModelCheck;
  }
  const shared = {
    ...(fetchImpl ? { fetchImpl } : {}),
    feature: DECISION_FEATURE,
    attempts: 1,
    retryRateLimit: false,
    timeoutMs: CHECK_TIMEOUT_MS,
  };
  const client =
    resolved.name === "openai"
      ? decisionClient({
          apiKey: resolved.apiKey,
          baseUrl: resolved.baseUrl,
          ...(resolved.model ? { model: resolved.model } : {}),
          ...shared,
        })
      : choiceClient({
          vendor: resolved.name,
          baseUrl: resolved.baseUrl,
          model: resolved.model ?? "",
          ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
          ...shared,
        });
  try {
    const { ms } = await timed(() =>
      client.decideChoice("I was charged twice, give me my money back", OPTIONS, FRAMING),
    );
    return {
      kind: "decision",
      ok: true,
      model: client.model,
      ms,
      message: `${client.model} answered.`,
    } satisfies ModelCheck;
  } catch (error) {
    return {
      kind: "decision",
      ok: false,
      model: client.model,
      message: explainModelError(
        { feature: DECISION_FEATURE, model: client.model, error, kind: "decision" },
        { config, environment },
      ),
    } satisfies ModelCheck;
  }
}

async function checkEmbedding(config: Config, environment: string, fetchImpl?: typeof fetch) {
  const provider = embeddingProviderFromConfig(config, fetchImpl);
  if (provider.local)
    return {
      kind: "embedding",
      ok: null,
      message: "Local hashing: no outbound call, so nothing to check.",
    } satisfies ModelCheck;
  try {
    const { ms } = await timed(() => provider.embed(["Reply with OK."]));
    return {
      kind: "embedding",
      ok: true,
      model: provider.model,
      ms,
      message: `${provider.model} answered.`,
    } satisfies ModelCheck;
  } catch (error) {
    return {
      kind: "embedding",
      ok: false,
      model: provider.model,
      message: explainModelError(
        { feature: EMBEDDINGS, model: provider.model, error, kind: "embedding" },
        { config, environment },
      ),
    } satisfies ModelCheck;
  }
}

/** One small call per kind of model, side by side; a kind that is off is not called. */
export async function checkModels(options: CheckOptions = {}): Promise<ModelCheck[]> {
  const config = options.config ?? getConfig();
  const environment = options.environment ?? deploymentEnvironment();
  return Promise.all([
    checkText(config, environment),
    checkDecision(config, environment, options.fetch),
    checkEmbedding(config, environment, options.fetch),
  ]);
}
