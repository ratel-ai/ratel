import { z } from "zod";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import {
  type ContentAccessDeps,
  contentHint,
  defaultContentAccessDeps,
  mayReadContent,
  withheldMarker,
} from "@/lib/mcp/operations/content-access";
import { mcpActor, mcpEventContext } from "@/lib/mcp/operations/health";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { cursorParam } from "@/lib/mcp/operations/runs";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { getDb } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { type ServerEventContext, trackServerEvent } from "@/lib/platform/telemetry";
import {
  createDrizzleDatasetStore,
  createDrizzleOverrideStore,
} from "@/lib/views/fine-tuning/adapters/drizzle-dataset-store";
import {
  createDrizzleModelCallSource,
  createDrizzleUseCaseStore,
} from "@/lib/views/fine-tuning/adapters/drizzle-store";
import { type StartResult, startDatasetBuild } from "@/lib/views/fine-tuning/build";
import { requestBuildDeps } from "@/lib/views/fine-tuning/build-route-deps";
import {
  BuildInputSchema,
  type Dataset,
  viewOfDataset,
} from "@/lib/views/fine-tuning/domain/dataset";
import { MAX_ROW_PAGE } from "@/lib/views/fine-tuning/domain/overrides";
import type { UseCaseStats } from "@/lib/views/fine-tuning/domain/stats";
import {
  parseSelector,
  SelectorError,
  type UseCase,
  UseCaseNameSchema,
  UseCaseSelectorSchema,
} from "@/lib/views/fine-tuning/domain/use-case";
import type { DatasetLifecycleEvent } from "@/lib/views/fine-tuning/export-api";
import { fineTuningEnabledForActor } from "@/lib/views/fine-tuning/flag";
import type {
  DatasetStore,
  UseCaseOverrideStore,
  UseCaseStore,
} from "@/lib/views/fine-tuning/ports/store";
import { loadUseCaseStats } from "@/lib/views/fine-tuning/resolve";
import {
  type OverrideEvent,
  overrideEvents,
  readRowPage,
  viewOfOverride,
} from "@/lib/views/fine-tuning/review-api";
import {
  trackDatasetLifecycleEvent,
  trackOverrideEvent,
} from "@/lib/views/fine-tuning/review-events";
import { USE_CASE_REJECTIONS, viewOfUseCase } from "@/lib/views/fine-tuning/use-cases-api";
import { datasetRef } from "@/lib/views/lineage/refs";

/**
 * The Fine-tuning page over MCP (RC-1124): `list_use_cases`,
 * `get_use_case` and `create_use_case`; (RC-1129) `build_dataset` and
 * `get_dataset`; (RC-1130) `list_dataset_rows` and
 * `set_use_case_override`; and (RC-1131) `delete_dataset`. Export has no
 * tool: `list_dataset_rows` is the MCP read path, and `get_dataset` gives
 * the console URLs of the export. They read and write through the
 * page's own `lib/fine-tuning` store, behind the page's flag,
 * `FF_FINE_TUNING`: off, they refuse as forbidden, as the page is not
 * found.
 *
 * Owned (ADR-0030): the default gate is the core switch `FF_FINE_TUNING` for the caller and the
 * project (`fineTuningEnabledForActor`), not upstream's session flag read.
 */

export interface FineTuningOperationDeps {
  /** `FF_FINE_TUNING` for the caller (`project:<id>` for a key, the identity-provider id for a person) and the project. */
  fineTuningEnabled: (projectId: string, actor: string) => Promise<boolean>;
  listUseCases: UseCaseStore["listUseCases"];
  getUseCase: UseCaseStore["getUseCase"];
  createUseCase: UseCaseStore["createUseCase"];
  /** Turns, calls, date range, current model and cost per run in the use case's window. */
  useCaseStats: (projectId: string, useCase: UseCase) => Promise<UseCaseStats>;
  track: (context: ServerEventContext, useCase: UseCase) => Promise<void>;
  /** Starts a dataset build: the guards (flag, training opt-in), a `building` version, its job. */
  buildDataset: (
    projectId: string,
    useCaseId: string,
    input: unknown,
    actor: string,
  ) => Promise<StartResult>;
  getDataset: (projectId: string, id: string) => Promise<Dataset | null>;
  listRows: DatasetStore["listRows"];
  listOverrides: UseCaseOverrideStore["listOverrides"];
  setOverride: UseCaseOverrideStore["setOverride"];
  trackOverride: (context: ServerEventContext, event: OverrideEvent) => Promise<void>;
  /** Deletes the version, its rows and its lineage link. */
  deleteDataset: DatasetStore["delete"];
  trackLifecycle: (context: ServerEventContext, event: DatasetLifecycleEvent) => Promise<void>;
  /** Row text follows the shared content rule (`content-access.ts`). */
  contentAccess: ContentAccessDeps;
}

export const defaultFineTuningDeps: FineTuningOperationDeps = {
  fineTuningEnabled: (projectId, actor) => fineTuningEnabledForActor(projectId, actor),
  listUseCases: (projectId, options) =>
    withStatementTimeout((db) => createDrizzleUseCaseStore(db).listUseCases(projectId, options), {
      operation: "mcp_list_use_cases",
    }),
  getUseCase: (projectId, id) =>
    withStatementTimeout((db) => createDrizzleUseCaseStore(db).getUseCase(projectId, id), {
      operation: "mcp_get_use_case",
    }),
  createUseCase: (projectId, input, actor) =>
    createDrizzleUseCaseStore(getDb()).createUseCase(projectId, input, actor),
  useCaseStats: (projectId, useCase) =>
    withStatementTimeout(
      (db) =>
        loadUseCaseStats(projectId, useCase.selector, createDrizzleModelCallSource(db), new Date()),
      { operation: "mcp_use_case_stats" },
    ),
  track: (context, useCase) =>
    trackServerEvent("use_case_created", context, {
      object_action: "use_case_created",
      use_case_id: useCase.id,
      tasks: useCase.selector.taskIds.length,
      intents: useCase.selector.intentIds.length,
      call_filter: useCase.selector.callFilter !== undefined,
      surface: "mcp",
    }),
  buildDataset: (projectId, useCaseId, input, actor) =>
    startDatasetBuild(projectId, useCaseId, input, actor, requestBuildDeps()),
  getDataset: (projectId, id) =>
    withStatementTimeout((db) => createDrizzleDatasetStore(db).getDataset(projectId, id), {
      operation: "mcp_get_dataset",
    }),
  listRows: (projectId, id, query) =>
    withStatementTimeout((db) => createDrizzleDatasetStore(db).listRows(projectId, id, query), {
      operation: "mcp_list_dataset_rows",
    }),
  listOverrides: (projectId, useCaseId) =>
    withStatementTimeout(
      (db) => createDrizzleOverrideStore(db).listOverrides(projectId, useCaseId),
      { operation: "mcp_list_use_case_overrides" },
    ),
  setOverride: (projectId, useCaseId, input, actor) =>
    createDrizzleOverrideStore(getDb()).setOverride(projectId, useCaseId, input, actor),
  trackOverride: (context, event) => trackOverrideEvent(event, context, "mcp"),
  deleteDataset: (projectId, id) => createDrizzleDatasetStore(getDb()).delete(projectId, id),
  trackLifecycle: (context, event) => trackDatasetLifecycleEvent(event, context, "mcp"),
  contentAccess: defaultContentAccessDeps,
};

export function fineTuningOperations(
  deps: FineTuningOperationDeps = defaultFineTuningDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "list_use_cases",
      domain: "improvement",
      title: "List fine-tuning use cases",
      description:
        "The project's fine-tuning use cases: each one is a name and a selector of model calls (tasks or intents, a date range, a model and span name filter). Call get_use_case for one.",
      keywords: ["fine-tuning", "use cases", "training data", "datasets", "small model"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        await requireFineTuning(deps, ctx.projectId, mcpActor(ctx.auth, ctx.projectId));
        const useCases = await deps.listUseCases(ctx.projectId);
        return {
          data: { useCases: useCases.map(viewOfUseCase) },
          ...(useCases.length === 0
            ? {
                hint: "No use case yet. Create one with create_use_case and a task id from list_tasks.",
              }
            : {}),
        };
      },
    }),
    defineOperation({
      id: "get_use_case",
      domain: "improvement",
      title: "Get a fine-tuning use case",
      description:
        "One fine-tuning use case from list_use_cases: its selector and its stats in its window (default the last 30 days): closed runs, model calls, first and last run, the most used model and the cost per run. costPerRunUsd null means Unpriced.",
      keywords: ["fine-tuning use case", "use case selector"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        useCaseId: uuidParam().describe("The use case id, as list_use_cases returns it."),
      }),
      async execute(ctx, params) {
        await requireFineTuning(deps, ctx.projectId, mcpActor(ctx.auth, ctx.projectId));
        const useCase = await deps.getUseCase(ctx.projectId, params.useCaseId);
        if (!useCase) throw notFound("use case");
        // biome-ignore lint/correctness/useHookAtTopLevel: a dependency named after upstream's, not a React hook
        const stats = await deps.useCaseStats(ctx.projectId, useCase);
        return {
          data: { ...viewOfUseCase(useCase), stats },
          ...(stats.sampled
            ? {
                hint: "More runs matched than were read: calls, model and cost come from the newest runs.",
              }
            : {}),
        };
      },
    }),
    defineOperation({
      id: "create_use_case",
      domain: "writes",
      title: "Create a fine-tuning use case",
      description:
        "Changes data: names a set of this project's model calls for a fine-tuning dataset. Give taskIds (from list_tasks) or intentIds (from list_intents), and optionally a dateRange and a callFilter of models and span names.",
      keywords: ["create use case", "fine-tuning", "select model calls", "training data"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        name: UseCaseNameSchema.describe("A name, unique among the project's use cases."),
        selector: UseCaseSelectorSchema.describe(
          "Which model calls: taskIds or intentIds, at least one, then optional dateRange and callFilter.",
        ),
      }),
      async execute(ctx, params) {
        const actor = mcpActor(ctx.auth, ctx.projectId);
        await requireFineTuning(deps, ctx.projectId, actor);
        const selector = checkedSelector(params.selector);
        const result = await deps.createUseCase(
          ctx.projectId,
          { name: params.name, selector },
          actor,
        );
        if (!result.ok)
          throw new McpOperationError("conflict", USE_CASE_REJECTIONS[result.reason].message, {
            reason: result.reason,
          });
        await deps.track(mcpEventContext(ctx), result.useCase);
        return { data: viewOfUseCase(result.useCase) };
      },
    }),
    defineOperation({
      id: "build_dataset",
      domain: "writes",
      title: "Build a fine-tuning dataset",
      description:
        "Changes data: copies the text of the use case's model calls (redacted of emails, phone numbers, cards, IBANs, national ids and secrets) into a new, immutable dataset version. It needs the project's training opt-in. The build runs in the background: poll get_dataset until status is ready or failed.",
      keywords: ["build dataset", "redacted dataset", "dataset version"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        useCaseId: uuidParam().describe("The use case id, as list_use_cases returns it."),
        settings: BuildInputSchema.optional().describe(
          "Optional build settings: filters (noError, noSelfCorrection), scorers (on or off; default on: a run that fails a task scorer or a user scorer is left out), dedup (off, exact or near; default near), seed and evalFraction (0 to 0.5, default 0.1). Calls that share a session or an end user always land on one side of the split.",
        ),
      }),
      async execute(ctx, params) {
        const actor = mcpActor(ctx.auth, ctx.projectId);
        await requireFineTuning(deps, ctx.projectId, actor);
        const result = await deps.buildDataset(
          ctx.projectId,
          params.useCaseId,
          params.settings ?? {},
          actor,
        );
        if (!result.ok) {
          if (result.reason === "use_case_not_found") throw notFound("use case");
          if (result.reason === "invalid")
            throw invalidParams(result.message, [{ path: "settings", message: result.message }]);
          throw new McpOperationError("forbidden", result.message, { reason: result.reason });
        }
        return {
          data: viewOfDataset(result.dataset),
          hint: "The build runs in the background. Call get_dataset with this id until status is ready or failed.",
        };
      },
    }),
    defineOperation({
      id: "get_dataset",
      domain: "improvement",
      title: "Get a fine-tuning dataset",
      description:
        "One dataset version from build_dataset: status (building, ready or failed), train and eval row counts, dropped counts per reason, scorerDrops (runs and calls left out per task scorer kind), the redaction report and settings. No row text: list_dataset_rows reads rows. consoleUrl and exportUrls open the page and the JSONL download for a signed-in member.",
      keywords: ["dataset status", "fine-tuning dataset", "redaction report"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        datasetId: uuidParam().describe("The dataset id, as build_dataset returns it."),
      }),
      async execute(ctx, params) {
        await requireFineTuning(deps, ctx.projectId, mcpActor(ctx.auth, ctx.projectId));
        const dataset = await deps.getDataset(ctx.projectId, params.datasetId);
        if (!dataset) throw notFound("dataset");
        return {
          data: { ...viewOfDataset(dataset), ...datasetUrls(dataset) },
          ...(dataset.status === "building"
            ? { hint: "Still building: call get_dataset again in a few seconds." }
            : {}),
        };
      },
    }),
    defineOperation({
      id: "list_dataset_rows",
      domain: "improvement",
      title: "List the rows of a fine-tuning dataset",
      description:
        "The rows of one dataset version in order: side (train or eval), source run (turnId, traceId), whether the use case pins or excludes that run, and the redacted input and output. Filter by side; page with cursor. Row text needs content access.",
      keywords: ["dataset rows", "review dataset", "training examples", "redacted rows"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        datasetId: uuidParam().describe("The dataset id, as build_dataset returns it."),
        side: z
          .enum(["train", "eval"])
          .optional()
          .describe("Only the rows of this side of the split."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_ROW_PAGE)
          .optional()
          .describe(`Rows per page, 1 to ${MAX_ROW_PAGE}; default 25.`),
        cursor: cursorParam,
      }),
      async execute(ctx, params) {
        await requireFineTuning(deps, ctx.projectId, mcpActor(ctx.auth, ctx.projectId));
        const dataset = await deps.getDataset(ctx.projectId, params.datasetId);
        if (!dataset) throw notFound("dataset");
        const content = await mayReadContent(ctx, deps.contentAccess);
        const page = await readRowPage(
          dataset,
          { side: params.side ?? null, cursor: params.cursor ?? null, limit: params.limit ?? null },
          {
            datasets: { listRows: deps.listRows },
            overrides: { listOverrides: deps.listOverrides },
          },
          content,
        );
        if (!page.ok)
          throw invalidParams(page.message, [{ path: "cursor", message: page.message }]);
        const hint = contentHint(
          content,
          page.nextCursor
            ? "Pass nextCursor as cursor, with the same datasetId and side, for the next page."
            : undefined,
        );
        return {
          data: { rows: page.rows, nextCursor: page.nextCursor, ...withheldMarker(content) },
          ...(hint ? { hint } : {}),
        };
      },
    }),
    defineOperation({
      id: "set_use_case_override",
      domain: "writes",
      title: "Pin or exclude a run of a fine-tuning use case",
      description:
        "Changes data: pins a run (turnId) of a use case so its calls skip the quality filter, or excludes it so no later build selects it. Give pinned or excluded (false clears it). Built versions do not change: it applies to the next build_dataset.",
      keywords: ["exclude run", "pin run", "dataset review", "use case override"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        useCaseId: uuidParam().describe("The use case id, as list_use_cases returns it."),
        turnId: uuidParam().describe("The run id, as list_dataset_rows returns it in turnId."),
        pinned: z.boolean().optional().describe("true pins the run, false unpins it."),
        excluded: z
          .boolean()
          .optional()
          .describe("true excludes the run from the next builds, false clears the exclusion."),
      }),
      async execute(ctx, params) {
        const actor = mcpActor(ctx.auth, ctx.projectId);
        await requireFineTuning(deps, ctx.projectId, actor);
        if (params.pinned === undefined && params.excluded === undefined) {
          throw invalidParams("Give pinned or excluded.", [
            { path: "pinned", message: "pinned or excluded is required" },
          ]);
        }
        const input = { turnId: params.turnId, pinned: params.pinned, excluded: params.excluded };
        const result = await deps.setOverride(ctx.projectId, params.useCaseId, input, actor);
        if (!result.ok) throw notFound(result.reason === "use_case_not_found" ? "use case" : "run");
        for (const event of overrideEvents(ctx.projectId, params.useCaseId, input))
          await deps.trackOverride(mcpEventContext(ctx), event);
        return {
          data: viewOfOverride(result.override),
          hint: "Built versions do not change. Call build_dataset for a new version with this change.",
        };
      },
    }),
    defineOperation({
      id: "delete_dataset",
      domain: "writes",
      title: "Delete a fine-tuning dataset",
      description:
        "Changes data, permanently: deletes one dataset version, all its rows and its lineage link. It cannot be undone. The use case and its other versions stay.",
      keywords: ["delete dataset", "remove dataset", "fine-tuning dataset"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        datasetId: uuidParam().describe("The dataset id, as build_dataset returns it."),
      }),
      async execute(ctx, params) {
        await requireFineTuning(deps, ctx.projectId, mcpActor(ctx.auth, ctx.projectId));
        const dataset = await deps.getDataset(ctx.projectId, params.datasetId);
        if (!dataset || !(await deps.deleteDataset(ctx.projectId, dataset.id)))
          throw notFound("dataset");
        await deps.trackLifecycle(mcpEventContext(ctx), {
          name: "dataset_deleted",
          projectId: ctx.projectId,
          dataset,
        });
        return { data: { deleted: dataset.id, version: dataset.version } };
      },
    }),
  ];
}

async function requireFineTuning(
  deps: FineTuningOperationDeps,
  projectId: string,
  actor: string,
): Promise<void> {
  if (!(await deps.fineTuningEnabled(projectId, actor))) {
    throw new McpOperationError("forbidden", "Fine-tuning is not available for this project.", {
      reason: "fine_tuning_off",
    });
  }
}

function checkedSelector(input: unknown) {
  try {
    return parseSelector(input);
  } catch (err) {
    if (err instanceof SelectorError)
      throw invalidParams(err.message, [{ path: "selector", message: err.code }]);
    throw err;
  }
}

/** The console page of a version and its JSONL downloads, which need a signed-in member. */
function datasetUrls(dataset: Dataset) {
  const api = `/api/projects/${encodeURIComponent(dataset.projectId)}/fine-tuning/datasets/${encodeURIComponent(dataset.id)}/export`;
  return {
    consoleUrl: datasetRef(dataset.projectId, dataset.id, dataset.useCaseId).href ?? null,
    exportUrls:
      dataset.status === "ready" ? { train: `${api}?side=train`, eval: `${api}?side=eval` } : null,
  };
}
