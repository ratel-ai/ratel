import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
} from "@/lib/platform/organization-flags";
import { notEnabledReason } from "@/lib/views/eval-gate/method";
import {
  defaultRunSettings,
  type EvalModels,
  evalModelCatalog,
  resolveEvalModels,
  SpendMeter,
} from "@/lib/views/eval-gate/models";
import { createDrizzleEvalStore } from "./adapters/drizzle-store";
import {
  type ModelCatalog,
  type ParsedRunSettings,
  parseRunSettings,
  type ResolvedRunSettings,
  type RunSettings,
  type RunSettingsUsed,
  resolveRunSettings,
  selectableModels,
} from "./domain/run-settings";
import type { Eval } from "./domain/types";
import { EVALS_OFF_ERROR, evalsEnabledForActor } from "./gate";
import type { EvalStore } from "./ports/store";
import type { ActionResult } from "./run";

/**
 * RC-653: the run settings of the eval jobs (`job.ts`, `simulation.ts`). Each
 * eval runs with its own resolved settings: its models, its step limit and its
 * own budget, held inside the run's reservation. With no settings stored, every
 * eval gets today's defaults, so a run is the same as before RC-653.
 */

/** What the run settings form shows: this level's settings, the level under it, and the models it may offer. */
export interface RunSettingsModel {
  level: "eval" | "suite";
  own: RunSettings;
  /** What an unset setting falls to: the suite's then today's (eval), or today's (suite). */
  inherited: ResolvedRunSettings;
  /** The served models Bedrock has enabled, in the backend's order. */
  models: string[];
  /** The served models Bedrock has not enabled (`model_not_enabled`). */
  notEnabled: string[];
}

export interface SaveRunSettingsDeps {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: { id: string }; organization: { id: string } } | null>;
  track?: (event: {
    externalId: string;
    projectId: string;
    organizationId: string;
    level: "eval" | "suite";
    evalId: string | null;
    settings: string[];
  }) => Promise<void>;
  db?: ReturnType<typeof getDb>;
  flagDeps?: OrganizationFlagDeps;
  catalog?: ModelCatalog;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logger = getLogger("evals/run-settings");

export interface RunSettingsDeps {
  /** Every eval gets these models, whatever its settings (tests). */
  models?: EvalModels;
  /** The models of one eval's settings. Defaults to `resolveEvalModels` with them. */
  modelsFor?: (settings: RunSettingsUsed) => EvalModels;
  /** Today's settings. Defaults to `defaultRunSettings()`. */
  defaults?: ResolvedRunSettings;
  /** The models the backend serves and has enabled. Defaults to `evalModelCatalog()`. */
  catalog?: ModelCatalog;
}

export interface EvalRunSettings {
  /** The suite's resolved settings: the cap of a run of more than one eval. */
  suite: RunSettingsUsed;
  forEval(item: Eval): RunSettingsUsed;
  modelsFor(settings: RunSettingsUsed): EvalModels;
  /** A chosen model that cannot run now, as the result's error; null when all can. */
  blocked(settings: RunSettingsUsed): string | null;
}

export async function loadEvalRunSettings(
  store: EvalStore,
  projectId: string,
  deps: RunSettingsDeps & { runBudgetUsd?: number },
): Promise<EvalRunSettings> {
  const base = deps.defaults ?? defaultRunSettings();
  const defaults =
    deps.runBudgetUsd !== undefined ? { ...base, budgetUsd: deps.runBudgetUsd } : base;
  const suiteSettings = await store.getSuiteRunSettings(projectId);
  const catalog = deps.catalog ?? evalModelCatalog();
  return {
    suite: resolveRunSettings(null, suiteSettings, defaults),
    forEval: (item) => resolveRunSettings(item.runSettings, suiteSettings, defaults),
    modelsFor: (settings) =>
      deps.models ??
      deps.modelsFor?.(settings) ??
      resolveEvalModels(undefined, "eval_gate_replay", undefined, undefined, settings),
    blocked: (settings) => {
      const chosen = (["agentModel", "toolModel", "judgeModel"] as const)
        .filter((key) => settings.sources[key] !== "default")
        .map((key) => settings[key]);
      const model = chosen.find(
        (id): id is string => typeof id === "string" && catalog.notEnabled.has(id),
      );
      return model ? notEnabledReason(model) : null;
    },
  };
}

/** The run's cap: one eval's own budget for a run of that eval, else the suite's. */
export function runCapUsd(
  settings: EvalRunSettings,
  evals: readonly Eval[],
  single: boolean,
): number {
  return single && evals[0] ? settings.forEval(evals[0]).budgetUsd : settings.suite.budgetUsd;
}

/** One eval's meter: its own budget, inside what is left of the run's. Absorb it into the run's meter after. */
export function evalMeter(run: SpendMeter, settings: RunSettingsUsed): SpendMeter {
  return new SpendMeter(Math.max(0, Math.min(settings.budgetUsd, run.capUsd - run.usd)));
}

/**
 * Check run settings before they are saved: the eval's against the suite's
 * agent model, the suite's alone. A model the backend does not serve, or that
 * Bedrock has not enabled, is refused with a message that names it.
 */
export async function checkRunSettings(
  input: unknown,
  store: EvalStore,
  projectId: string,
  level: "eval" | "suite",
  catalog: ModelCatalog = evalModelCatalog(),
): Promise<ParsedRunSettings> {
  const fallback: RunSettings | null =
    level === "eval" ? await store.getSuiteRunSettings(projectId) : null;
  return parseRunSettings(input, catalog, fallback);
}

/**
 * The server action's work: save the run settings of one eval (`evalId`) or of
 * the suite (`evalId` null). The caller must be a member with `cloud-eval-gate`
 * on. A model the backend does not serve, or that Bedrock has not enabled, is
 * refused with a message that names it.
 */
export async function saveRunSettings(
  projectId: string,
  evalId: string | null,
  input: unknown,
  deps: SaveRunSettingsDeps,
): Promise<ActionResult<RunSettings>> {
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to change run settings." };
  const scope = UUID.test(projectId)
    ? await deps.findProjectScope(projectId, session.user.id)
    : null;
  if (!scope) return { ok: false, error: "No project you belong to has that ID." };
  const db = deps.db ?? getDb();
  const actor = session.user.externalId;
  if (
    !(await evalsEnabledForActor(
      scope.project.id,
      actor,
      db,
      deps.flagDeps ?? defaultOrganizationFlagDeps,
    ))
  )
    return { ok: false, error: EVALS_OFF_ERROR };
  const store = createDrizzleEvalStore(db);
  const level = evalId === null ? "suite" : "eval";
  if (evalId !== null && !(UUID.test(evalId) && (await store.getEval(scope.project.id, evalId))))
    return { ok: false, error: "No eval in this project has that ID." };
  const checked = await checkRunSettings(input, store, scope.project.id, level, deps.catalog);
  if (!checked.ok) return { ok: false, error: checked.error };
  const saved =
    evalId === null
      ? await store.setSuiteRunSettings(scope.project.id, checked.value, actor)
      : ((await store.setEvalRunSettings(scope.project.id, evalId, checked.value))?.runSettings ??
        {});
  logger.info(
    { project_id: scope.project.id, eval_id: evalId, level, settings: Object.keys(saved), actor },
    "eval_run_settings_set",
  );
  await deps.track?.({
    externalId: actor,
    projectId: scope.project.id,
    organizationId: scope.organization.id,
    level,
    evalId,
    settings: Object.keys(saved),
  });
  return { ok: true, value: saved };
}

/** The run settings form of one eval (`item`) or of the suite (`item` null). */
export async function loadRunSettingsModel(
  projectId: string,
  item: Eval | null,
  deps: {
    db?: ReturnType<typeof getDb>;
    defaults?: ResolvedRunSettings;
    catalog?: ModelCatalog;
  } = {},
): Promise<RunSettingsModel> {
  const store = createDrizzleEvalStore(deps.db ?? getDb());
  const catalog = deps.catalog ?? evalModelCatalog();
  const defaults = deps.defaults ?? defaultRunSettings();
  const suite = await store.getSuiteRunSettings(projectId);
  const { sources: _sources, ...inherited } = resolveRunSettings(
    null,
    item ? suite : null,
    defaults,
  );
  return {
    level: item ? "eval" : "suite",
    own: item ? (item.runSettings ?? {}) : suite,
    inherited,
    models: selectableModels(catalog),
    notEnabled: catalog.served.filter((model) => catalog.notEnabled.has(model)),
  };
}
