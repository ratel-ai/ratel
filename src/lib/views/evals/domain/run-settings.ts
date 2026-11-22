/**
 * RC-653: the run settings of an eval run: the models it calls and its limits.
 * Each setting comes from the eval, else the suite default of the project, else
 * today's default (`defaultRunSettings` in lib/eval-gate/models.ts). An eval or
 * a suite with no settings runs as before. Pure: the models the backend serves
 * come in as a `ModelCatalog`.
 */

export const RUN_SETTING_KEYS = [
  "agentModel",
  "temperature",
  "maxTokens",
  "maxSteps",
  "budgetUsd",
  "toolModel",
  "judgeModel",
] as const;
export type RunSettingKey = (typeof RUN_SETTING_KEYS)[number];

/** What an eval or the suite sets. A missing key falls through to the next level. */
export interface RunSettings {
  /** The agent's model. Unset: the recorded run's model, else the replay's fallback. */
  agentModel?: string;
  temperature?: number;
  /** The most one agent answer may be (`max_tokens`). */
  maxTokens?: number;
  /** The most agent steps one replay takes. */
  maxSteps?: number;
  /** The most one run may spend on models, in USD. */
  budgetUsd?: number;
  /** The model that answers a tool call the recording has no result for, and writes a simulated person's messages. */
  toolModel?: string;
  /** The model of the criteria judge and of judge scorers. */
  judgeModel?: string;
}

/** Every setting decided. `agentModel` null: the recorded model. `temperature` null: today's (0 for a model that takes one). */
export interface ResolvedRunSettings {
  agentModel: string | null;
  temperature: number | null;
  maxTokens: number;
  maxSteps: number;
  budgetUsd: number;
  toolModel: string;
  judgeModel: string;
}

export type RunSettingSource = "eval" | "suite" | "default";

/** The settings one result ran with, and where each came from. Stored on each `eval_results` row. */
export interface RunSettingsUsed extends ResolvedRunSettings {
  sources: Record<RunSettingKey, RunSettingSource>;
}

/** The Claude models this deployment's backend serves, and those Bedrock has not enabled (RC-589). */
export interface ModelCatalog {
  served: readonly string[];
  notEnabled: ReadonlySet<string>;
}

export type ParsedRunSettings =
  | { ok: true; value: RunSettings }
  | { ok: false; error: string; reason?: "model_not_enabled" };

export const MAX_TEMPERATURE = 1;
export const MAX_TOKENS_LIMIT = 64_000;
export const MAX_STEPS_LIMIT = 50;
/** No run may hold more than the organization's daily budget (`DAILY_ORG_BUDGET_USD`). */
export const MAX_BUDGET_USD = 10;

const MODEL_KEYS = ["agentModel", "toolModel", "judgeModel"] as const;
const MODEL_LABELS: Record<(typeof MODEL_KEYS)[number], string> = {
  agentModel: "agent model",
  toolModel: "tool answer model",
  judgeModel: "judge model",
};

/** Each setting from the eval, else the suite, else the default. */
export function resolveRunSettings(
  evalSettings: RunSettings | null | undefined,
  suite: RunSettings | null | undefined,
  defaults: ResolvedRunSettings,
): RunSettingsUsed {
  const resolved: Record<RunSettingKey, unknown> = { ...defaults };
  const sources = {} as Record<RunSettingKey, RunSettingSource>;
  for (const key of RUN_SETTING_KEYS) {
    if (evalSettings?.[key] !== undefined) {
      resolved[key] = evalSettings[key];
      sources[key] = "eval";
    } else if (suite?.[key] !== undefined) {
      resolved[key] = suite[key];
      sources[key] = "suite";
    } else {
      sources[key] = "default";
    }
  }
  return { ...(resolved as unknown as ResolvedRunSettings), sources };
}

/**
 * Settings from a form or a tool call, checked before they are saved. A null
 * value clears that setting. A model must be one the backend serves and Bedrock
 * has enabled. `fallback`: the next level's settings (the suite's, for an
 * eval), so a temperature is checked against the agent model the run will use.
 */
export function parseRunSettings(
  input: unknown,
  catalog: ModelCatalog,
  fallback?: RunSettings | null,
): ParsedRunSettings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "Run settings must be an object." };
  const raw = input as Record<string, unknown>;
  const unknownKey = Object.keys(raw).find(
    (key) => !(RUN_SETTING_KEYS as readonly string[]).includes(key),
  );
  if (unknownKey)
    return {
      ok: false,
      error: `${unknownKey} is not a run setting. The run settings are ${RUN_SETTING_KEYS.join(", ")}.`,
    };
  const value: RunSettings = {};
  for (const key of MODEL_KEYS) {
    const model = raw[key];
    if (model === undefined || model === null) continue;
    const checked = checkModel(model, catalog, MODEL_LABELS[key]);
    if (!checked.ok) return checked;
    value[key] = checked.model;
  }
  const temperature = numberSetting(raw.temperature, "Temperature", 0, MAX_TEMPERATURE, false);
  if (typeof temperature === "string") return { ok: false, error: temperature };
  if (temperature !== undefined) value.temperature = temperature;
  const maxTokens = numberSetting(raw.maxTokens, "Max tokens", 1, MAX_TOKENS_LIMIT, true);
  if (typeof maxTokens === "string") return { ok: false, error: maxTokens };
  if (maxTokens !== undefined) value.maxTokens = maxTokens;
  const maxSteps = numberSetting(raw.maxSteps, "The step limit", 1, MAX_STEPS_LIMIT, true);
  if (typeof maxSteps === "string") return { ok: false, error: maxSteps };
  if (maxSteps !== undefined) value.maxSteps = maxSteps;
  const budgetUsd = numberSetting(raw.budgetUsd, "The cost budget", 0, MAX_BUDGET_USD, false);
  if (typeof budgetUsd === "string") return { ok: false, error: budgetUsd };
  if (budgetUsd !== undefined) {
    if (budgetUsd <= 0) return { ok: false, error: "The cost budget must be more than $0." };
    value.budgetUsd = budgetUsd;
  }
  const agentModel = value.agentModel ?? fallback?.agentModel;
  if (value.temperature !== undefined && agentModel && !acceptsTemperature(agentModel)) {
    return {
      ok: false,
      error: `${agentModel} does not take a temperature. Choose a 4.x agent model, or clear the temperature.`,
    };
  }
  return { ok: true, value };
}

/** Sampling parameters are refused from the 5.x generation on; the 4.x models take a temperature. */
export function acceptsTemperature(model: string): boolean {
  return /^claude-(opus|sonnet|haiku)-[34]/.test(model);
}

/** The models a list may offer: the served ones that Bedrock has enabled. */
export function selectableModels(catalog: ModelCatalog): string[] {
  return catalog.served.filter((model) => !catalog.notEnabled.has(model));
}

function checkModel(
  model: unknown,
  catalog: ModelCatalog,
  label: string,
): { ok: true; model: string } | { ok: false; error: string; reason?: "model_not_enabled" } {
  if (typeof model !== "string" || model.trim() === "")
    return { ok: false, error: `The ${label} must be a model id.` };
  const id = model.trim();
  if (!catalog.served.includes(id)) {
    return {
      ok: false,
      error: `${id} is not a Claude model that this backend serves. Choose one of: ${selectableModels(catalog).join(", ")}.`,
    };
  }
  if (catalog.notEnabled.has(id))
    return {
      ok: false,
      error: `${id} is not enabled on Bedrock (model_not_enabled). Choose another model.`,
      reason: "model_not_enabled",
    };
  return { ok: true, model: id };
}

/** A number setting in [min, max]; undefined when unset or null, a message when wrong. */
function numberSetting(
  value: unknown,
  label: string,
  min: number,
  max: number,
  integer: boolean,
): number | undefined | string {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return `${label} must be a number.`;
  if (integer && !Number.isInteger(value)) return `${label} must be a whole number.`;
  if (value < min || value > max) return `${label} must be from ${min} to ${max}.`;
  return value;
}

/** RC-653: the settings a result ran with, one label and value each, for the replay header. A setting the eval or the suite chose says so. */
export function runSettingsSummary(
  used: RunSettingsUsed,
): { key: RunSettingKey; label: string; value: string; source: RunSettingSource }[] {
  const values: Record<RunSettingKey, string> = {
    agentModel: used.agentModel ?? "Recorded model",
    temperature: used.temperature === null ? "Default" : String(used.temperature),
    maxTokens: used.maxTokens.toLocaleString("en-US"),
    maxSteps: String(used.maxSteps),
    budgetUsd: `$${used.budgetUsd.toFixed(used.budgetUsd < 1 ? 2 : 0)}`,
    toolModel: used.toolModel,
    judgeModel: used.judgeModel,
  };
  return RUN_SETTING_KEYS.map((key) => ({
    key,
    label: RUN_SETTING_LABELS[key],
    value: values[key],
    source: used.sources[key],
  }));
}

export const RUN_SETTING_LABELS: Record<RunSettingKey, string> = {
  agentModel: "Agent model",
  temperature: "Temperature",
  maxTokens: "Max tokens",
  maxSteps: "Step limit",
  budgetUsd: "Cost budget",
  toolModel: "Tool answer model",
  judgeModel: "Judge model",
};
