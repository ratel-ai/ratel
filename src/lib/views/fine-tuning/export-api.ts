import { getLogger } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import {
  type Dataset,
  type ExportSkipCounts,
  emptyExportSkips,
  viewOfDataset,
} from "./domain/dataset";
import { EXPORT_SKIP_REASONS, toChatExample } from "./domain/jsonl";
import type { DatasetSide } from "./domain/rows";
import type { DatasetStore } from "./ports/store";

/**
 * Read, export and delete of a dataset version (RC-1131, RC-1178):
 * - `GET /api/projects/<id>/fine-tuning/datasets/<datasetId>` returns its
 *   view (`viewOfDataset`, as MCP `get_dataset`): status, counts, redaction
 *   report, settings and content hash, never row text. A read tracks nothing.
 * - `GET /api/projects/<id>/fine-tuning/datasets/<datasetId>/export?side=train|eval`
 *   streams one side as OpenAI chat fine-tuning JSONL, a page of rows at a
 *   time over (dataset_id, ordinal), so no export holds the dataset in
 *   memory. Session auth only (decision `storage-postgres`: no signed link):
 *   a request with an API key is refused. Rows the format cannot express are
 *   skipped, and `x-ratel-skipped-rows` says how many; (RC-1176)
 *   `x-ratel-skipped-reasons` says why, as `reason=n` pairs.
 * - `DELETE /api/projects/<id>/fine-tuning/datasets/<datasetId>` removes the
 *   version, its rows and its lineage link.
 * Behind `FF_FINE_TUNING`: off, the routes are not found. A support
 * session can do neither. Never logs row content.
 */

/** Rows read per page of an export. */
export const EXPORT_PAGE_ROWS = 500;
export const SKIPPED_HEADER = "x-ratel-skipped-rows";
export const ROWS_HEADER = "x-ratel-rows";
export const SKIPPED_REASONS_HEADER = "x-ratel-skipped-reasons";

export type DatasetLifecycleEvent =
  | {
      name: "dataset_exported";
      projectId: string;
      dataset: Dataset;
      side: DatasetSide;
      rows: number;
      skipped: number;
    }
  | { name: "dataset_deleted"; projectId: string; dataset: Dataset };

export interface ExportApiDeps {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: Project; organization: Organization; role: string } | null>;
  fineTuningEnabled: (organization: Organization) => Promise<boolean>;
  isRestricted: () => Promise<boolean>;
  datasets: () => Pick<DatasetStore, "getDataset" | "listRows" | "delete">;
  track: (
    event: DatasetLifecycleEvent,
    actor: { externalId: string; organizationId: string },
  ) => Promise<void>;
  pageRows?: number;
}

const logger = getLogger("fine-tuning/export");

export async function handleDatasetExportRequest(
  request: Request,
  projectId: string,
  datasetId: string,
  deps: ExportApiDeps,
): Promise<Response> {
  if (request.headers.has("authorization")) {
    return json(403, {
      ok: false,
      error: "api_key",
      message:
        "Export needs a signed-in session. With an API key, read rows with the list_dataset_rows tool.",
    });
  }
  const scope = await scopeOf(projectId, deps);
  if (scope instanceof Response) return scope;
  if (await deps.isRestricted())
    return json(403, {
      ok: false,
      error: "restricted",
      message: "A support session cannot export datasets.",
    });
  const side = new URL(request.url).searchParams.get("side");
  if (side !== "train" && side !== "eval")
    return json(400, { ok: false, error: "invalid_params", message: "side is train or eval." });
  const datasets = deps.datasets();
  const dataset = await datasets.getDataset(scope.project.id, datasetId);
  if (!dataset)
    return json(404, {
      ok: false,
      error: "dataset_not_found",
      message: "This project has no dataset with that ID.",
    });
  if (dataset.status !== "ready" || !dataset.counts)
    return json(409, {
      ok: false,
      error: "not_ready",
      message: "Only a ready dataset can be exported.",
    });

  const pageRows = deps.pageRows ?? EXPORT_PAGE_ROWS;
  const reasons =
    dataset.counts.exportSkipReasons?.[side] ??
    (await countSkipped(datasets, dataset, side, pageRows));
  const skipped = EXPORT_SKIP_REASONS.reduce((sum, reason) => sum + reasons[reason], 0);
  const rows = dataset.counts[side] - skipped;
  logger.info(
    { project_id: dataset.projectId, dataset_id: dataset.id, side, rows, skipped },
    "dataset export started",
  );
  await deps.track(
    { name: "dataset_exported", projectId: dataset.projectId, dataset, side, rows, skipped },
    scope.actor,
  );

  return new Response(jsonlStream(datasets, dataset, side, pageRows), {
    status: 200,
    headers: {
      "content-type": "application/jsonl; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFileName(dataset, side)}"`,
      "cache-control": "private, no-store",
      [SKIPPED_HEADER]: String(skipped),
      [SKIPPED_REASONS_HEADER]: EXPORT_SKIP_REASONS.filter((reason) => reasons[reason] > 0)
        .map((reason) => `${reason}=${reasons[reason]}`)
        .join(","),
      [ROWS_HEADER]: String(rows),
    },
  });
}

export async function handleDatasetGetRequest(
  projectId: string,
  datasetId: string,
  deps: ExportApiDeps,
): Promise<Response> {
  const scope = await scopeOf(projectId, deps);
  if (scope instanceof Response) return scope;
  const dataset = await deps.datasets().getDataset(scope.project.id, datasetId);
  if (!dataset)
    return json(404, {
      ok: false,
      error: "dataset_not_found",
      message: "This project has no dataset with that ID.",
    });
  return json(200, { ok: true, dataset: viewOfDataset(dataset) });
}

export async function handleDatasetDeleteRequest(
  projectId: string,
  datasetId: string,
  deps: ExportApiDeps,
): Promise<Response> {
  const scope = await scopeOf(projectId, deps);
  if (scope instanceof Response) return scope;
  if (await deps.isRestricted())
    return json(403, {
      ok: false,
      error: "restricted",
      message: "A support session cannot delete datasets.",
    });
  const datasets = deps.datasets();
  const dataset = await datasets.getDataset(scope.project.id, datasetId);
  if (!dataset || !(await datasets.delete(scope.project.id, dataset.id))) {
    return json(404, {
      ok: false,
      error: "dataset_not_found",
      message: "This project has no dataset with that ID.",
    });
  }
  logger.info(
    { project_id: dataset.projectId, dataset_id: dataset.id, version: dataset.version },
    "dataset deleted",
  );
  await deps.track({ name: "dataset_deleted", projectId: dataset.projectId, dataset }, scope.actor);
  return json(200, { ok: true, deleted: dataset.id });
}

/** `<use case id prefix>-v<version>-<side>.jsonl`: plain ASCII, safe in a header. */
export function exportFileName(
  dataset: Pick<Dataset, "useCaseId" | "version">,
  side: DatasetSide,
): string {
  return `fine-tuning-${dataset.useCaseId.slice(0, 8)}-v${dataset.version}-${side}.jsonl`;
}

/** The JSONL of one side, one page of rows per pull. */
function jsonlStream(
  datasets: Pick<DatasetStore, "listRows">,
  dataset: Dataset,
  side: DatasetSide,
  pageRows: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let after: number | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const page = await datasets.listRows(dataset.projectId, dataset.id, {
          side,
          after,
          limit: pageRows,
        });
        const lines = page.flatMap((row) => {
          const example = toChatExample(row.content);
          return example.ok ? [`${example.line}\n`] : [];
        });
        if (lines.length > 0) controller.enqueue(encoder.encode(lines.join("")));
        const last = page[page.length - 1];
        if (page.length < pageRows || !last) controller.close();
        else after = last.ordinal;
      } catch (err) {
        logger.error(
          { err, project_id: dataset.projectId, dataset_id: dataset.id, side },
          "dataset export failed",
        );
        controller.error(err);
      }
    },
  });
}

/** For a version built before RC-1176, which did not store its skipped counts by reason: one counting pass, a page at a time. */
async function countSkipped(
  datasets: Pick<DatasetStore, "listRows">,
  dataset: Dataset,
  side: DatasetSide,
  pageRows: number,
): Promise<ExportSkipCounts> {
  const skipped = emptyExportSkips();
  for (let after: number | null = null; ; ) {
    const page = await datasets.listRows(dataset.projectId, dataset.id, {
      side,
      after,
      limit: pageRows,
    });
    for (const row of page) {
      const example = toChatExample(row.content);
      if (!example.ok) skipped[example.reason] += 1;
    }
    const last = page[page.length - 1];
    if (page.length < pageRows || !last) return skipped;
    after = last.ordinal;
  }
}

async function scopeOf(projectId: string, deps: ExportApiDeps) {
  const session = await deps.getSession();
  if (!session)
    return json(401, {
      ok: false,
      error: "signed_out",
      message: "Sign in to read, export or delete datasets.",
    });
  const scope = await deps.findProjectScope(projectId, session.user.id);
  if (!scope || !(await deps.fineTuningEnabled(scope.organization))) {
    return json(404, {
      ok: false,
      error: "not_found",
      message: "No project you belong to has that ID.",
    });
  }
  return {
    ...scope,
    actor: { externalId: session.user.externalId, organizationId: scope.organization.id },
  };
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
