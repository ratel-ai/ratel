import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import type { Dataset } from "./domain/dataset";
import {
  type DatasetRowView,
  DEFAULT_ROW_PAGE,
  decodeRowCursor,
  encodeRowCursor,
  MAX_ROW_PAGE,
  type OverrideInput,
  OverrideInputSchema,
  type UseCaseOverride,
} from "./domain/overrides";
import type { DatasetSide } from "./domain/rows";
import type { DatasetStore, UseCaseOverrideStore } from "./ports/store";

/**
 * The review step of a dataset (RC-1130):
 * - `GET /api/projects/<id>/fine-tuning/datasets/<datasetId>/rows` pages
 *   through a version's rows in ordinal order (`side`, `cursor`, `limit`).
 * - `PUT /api/projects/<id>/fine-tuning/use-cases/<useCaseId>/overrides`
 *   pins or excludes one run for the next builds. A built version never
 *   changes.
 * Behind `FF_FINE_TUNING`: off, the routes are not found. A support
 * session only reads. `list_dataset_rows` and `set_use_case_override` share
 * {@link readRowPage} and the store.
 */

export type OverrideEventName = "dataset_row_excluded" | "dataset_row_pinned";

export interface OverrideEvent {
  name: OverrideEventName;
  /** The new value: true for an exclusion or a pin, false when it was cleared. */
  value: boolean;
  projectId: string;
  useCaseId: string;
  turnId: string;
}

export interface ReviewApiDeps {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: Project; organization: Organization; role: string } | null>;
  fineTuningEnabled: (organization: Organization) => Promise<boolean>;
  isRestricted: () => Promise<boolean>;
  datasets: () => Pick<DatasetStore, "getDataset" | "listRows">;
  overrides: () => UseCaseOverrideStore;
  track: (
    event: OverrideEvent,
    actor: { externalId: string; organizationId: string },
  ) => Promise<void>;
}

export interface RowPage {
  rows: DatasetRowView[];
  nextCursor: string | null;
}

export type RowPageParams = {
  side?: string | null;
  cursor?: string | null;
  limit?: number | string | null;
};

export type RowPageRefusal = { ok: false; error: "invalid_params"; message: string };

export async function handleDatasetRowsRequest(
  request: Request,
  projectId: string,
  datasetId: string,
  deps: ReviewApiDeps,
): Promise<Response> {
  const scope = await scopeOf(projectId, deps);
  if (scope instanceof Response) return scope;
  const datasets = deps.datasets();
  const dataset = await datasets.getDataset(scope.project.id, datasetId);
  if (!dataset)
    return json(404, {
      ok: false,
      error: "dataset_not_found",
      message: "This project has no dataset with that ID.",
    });
  const url = new URL(request.url);
  const page = await readRowPage(
    dataset,
    {
      side: url.searchParams.get("side"),
      cursor: url.searchParams.get("cursor"),
      limit: url.searchParams.get("limit"),
    },
    { datasets, overrides: deps.overrides() },
    true,
  );
  if (!page.ok) return json(400, page);
  return json(200, { ok: true, rows: page.rows, nextCursor: page.nextCursor });
}

export async function handleOverridesRequest(
  request: Request,
  projectId: string,
  useCaseId: string,
  deps: ReviewApiDeps,
): Promise<Response> {
  const scope = await scopeOf(projectId, deps);
  if (scope instanceof Response) return scope;
  if (await deps.isRestricted())
    return json(403, {
      ok: false,
      error: "restricted",
      message: "A support session cannot change a use case.",
    });
  const parsed = OverrideInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return json(400, {
      ok: false,
      error: "invalid_params",
      message: parsed.error.issues[0]?.message ?? "Give a turnId and pinned or excluded.",
    });
  const result = await deps
    .overrides()
    .setOverride(scope.project.id, useCaseId, parsed.data, scope.externalId);
  if (!result.ok) {
    const message =
      result.reason === "use_case_not_found"
        ? "This project has no use case with that ID."
        : "This project has no run with that ID.";
    return json(404, { ok: false, error: result.reason, message });
  }
  for (const event of overrideEvents(scope.project.id, useCaseId, parsed.data)) {
    await deps.track(event, {
      externalId: scope.externalId,
      organizationId: scope.organization.id,
    });
  }
  return json(200, { ok: true, override: viewOfOverride(result.override) });
}

/**
 * One page of a version's rows, with each row's pin and exclusion on its use
 * case. `content` is null on every row when the caller may not read the text.
 */
export async function readRowPage(
  dataset: Dataset,
  params: RowPageParams,
  deps: {
    datasets: Pick<DatasetStore, "listRows">;
    overrides: Pick<UseCaseOverrideStore, "listOverrides">;
  },
  includeContent: boolean,
): Promise<({ ok: true } & RowPage) | RowPageRefusal> {
  const side =
    params.side === null || params.side === undefined || params.side === "" ? null : params.side;
  if (side !== null && side !== "train" && side !== "eval")
    return refusal("side is train or eval.");
  const limit =
    params.limit === null || params.limit === undefined || params.limit === ""
      ? DEFAULT_ROW_PAGE
      : Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROW_PAGE)
    return refusal(`limit is a whole number from 1 to ${MAX_ROW_PAGE}.`);
  const after = params.cursor ? decodeRowCursor(params.cursor, dataset.id, side) : null;
  if (params.cursor && after === null)
    return refusal("The cursor does not belong to this dataset and side. Start again without it.");

  // One more row than the page says whether there is a next page.
  const [listed, overrides] = await Promise.all([
    deps.datasets.listRows(dataset.projectId, dataset.id, { side, after, limit: limit + 1 }),
    deps.overrides.listOverrides(dataset.projectId, dataset.useCaseId),
  ]);
  const byTurn = new Map(overrides.map((override) => [override.turnId, override]));
  const rows = listed.slice(0, limit).map(
    (row): DatasetRowView => ({
      ordinal: row.ordinal,
      side: row.side,
      turnId: row.turnId,
      traceId: row.traceId,
      spanId: row.spanId,
      capturedAt: row.capturedAt.toISOString(),
      pinned: byTurn.get(row.turnId)?.pinned ?? false,
      excluded: byTurn.get(row.turnId)?.excluded ?? false,
      content: includeContent ? row.content : null,
    }),
  );
  const last = rows[rows.length - 1];
  return {
    ok: true,
    rows,
    nextCursor:
      listed.length > limit && last
        ? encodeRowCursor(dataset.id, side as DatasetSide | null, last.ordinal)
        : null,
  };
}

/** The events one override change emits: one per field it set. */
export function overrideEvents(
  projectId: string,
  useCaseId: string,
  input: OverrideInput,
): OverrideEvent[] {
  return [
    ...(input.excluded === undefined
      ? []
      : [{ name: "dataset_row_excluded" as const, value: input.excluded }]),
    ...(input.pinned === undefined
      ? []
      : [{ name: "dataset_row_pinned" as const, value: input.pinned }]),
  ].map((event) => ({ ...event, projectId, useCaseId, turnId: input.turnId }));
}

export function viewOfOverride(override: UseCaseOverride) {
  return {
    turnId: override.turnId,
    pinned: override.pinned,
    excluded: override.excluded,
    setBy: override.setBy,
    updatedAt: override.updatedAt.toISOString(),
  };
}

async function scopeOf(projectId: string, deps: ReviewApiDeps) {
  const session = await deps.getSession();
  if (!session)
    return json(401, { ok: false, error: "signed_out", message: "Sign in to see datasets." });
  const scope = await deps.findProjectScope(projectId, session.user.id);
  if (!scope || !(await deps.fineTuningEnabled(scope.organization))) {
    return json(404, {
      ok: false,
      error: "not_found",
      message: "No project you belong to has that ID.",
    });
  }
  return { ...scope, externalId: session.user.externalId };
}

function refusal(message: string): RowPageRefusal {
  return { ok: false, error: "invalid_params", message };
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
