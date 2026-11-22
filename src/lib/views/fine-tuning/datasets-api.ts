import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { type DatasetBuildDeps, startDatasetBuild } from "./build";
import { viewOfDataset } from "./domain/dataset";

/**
 * `/api/projects/<id>/fine-tuning/use-cases/<useCaseId>/datasets` (RC-1128):
 * `GET` lists the use case's dataset versions, `POST` starts a build. Any
 * member may build; a support session only reads. Behind `FF_FINE_TUNING`:
 * off, the route is not found. A build with no training opt-in is refused
 * with `no_consent`. Store errors propagate to `withRequestLog()`.
 */

export interface DatasetsApiDeps {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: Project; organization: Organization; role: string } | null>;
  fineTuningEnabled: (organization: Organization) => Promise<boolean>;
  isRestricted: () => Promise<boolean>;
  build: () => DatasetBuildDeps;
}

const REFUSAL_STATUS = {
  flag_off: 404,
  no_consent: 409,
  use_case_not_found: 404,
  too_large: 422,
  no_rows: 422,
  invalid: 400,
} as const;

export async function handleDatasetsRequest(
  request: Request,
  projectId: string,
  useCaseId: string,
  deps: DatasetsApiDeps,
): Promise<Response> {
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
  const build = deps.build();
  const useCase = await build.useCases.getUseCase(scope.project.id, useCaseId);
  if (!useCase)
    return json(404, {
      ok: false,
      error: "use_case_not_found",
      message: "This project has no use case with that ID.",
    });

  if (request.method === "GET") {
    const datasets = await build.datasets.listDatasets(scope.project.id, useCase.id);
    return json(200, { ok: true, datasets: datasets.map(viewOfDataset) });
  }

  if (await deps.isRestricted())
    return json(403, {
      ok: false,
      error: "restricted",
      message: "A support session cannot build datasets.",
    });
  const body = await request.json().catch(() => null);
  const result = await startDatasetBuild(
    scope.project.id,
    useCase.id,
    body,
    session.user.externalId,
    build,
  );
  if (!result.ok)
    return json(REFUSAL_STATUS[result.reason], {
      ok: false,
      error: result.reason,
      message: result.message,
    });
  return json(202, { ok: true, dataset: viewOfDataset(result.dataset) });
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
