/** Where the Evals pages live (RC-290/291): the list, one run's table and one eval. */

export type EvalsTab = "evals" | "runs";
/** RC-323: the eval set filtered to suggestions (`?status=suggested`); null is all. */
export type EvalStatusFilter = "suggested" | null;

/** Each tab is its own path (DESIGN.md, Everything is a URL): `/evals` and `/evals/runs`. */
export function evalsHref(
  projectId: string,
  query: { task?: string | null; tab?: EvalsTab; status?: EvalStatusFilter } = {},
): string {
  const search = new URLSearchParams();
  if (query.task) search.set("task", query.task);
  if (query.status) search.set("status", query.status);
  const path = `/project/${encodeURIComponent(projectId)}/evals${query.tab === "runs" ? "/runs" : ""}`;
  return search.size > 0 ? `${path}?${search}` : path;
}

export function evalRunHref(
  projectId: string,
  runId: string,
  filter?: "failing" | "changed",
): string {
  const path = `/project/${encodeURIComponent(projectId)}/evals/runs/${encodeURIComponent(runId)}`;
  return filter ? `${path}?show=${filter}` : path;
}

/** RC-297: the editor; with `run` and `mock`, that run's step `mock` is filled in as a fixed answer. */
export function editEvalHref(
  projectId: string,
  evalId: string,
  mock?: { run: string; mock: number },
): string {
  const search = new URLSearchParams({ edit: "1" });
  if (mock) {
    search.set("run", mock.run);
    search.set("mock", String(mock.mock));
  }
  return `/project/${encodeURIComponent(projectId)}/evals/${encodeURIComponent(evalId)}?${search}`;
}

export function evalHref(
  projectId: string,
  evalId: string,
  query: { tab?: "runs" | "definition"; run?: string } = {},
): string {
  const search = new URLSearchParams();
  if (query.tab) search.set("tab", query.tab);
  if (query.run) search.set("run", query.run);
  const path = `/project/${encodeURIComponent(projectId)}/evals/${encodeURIComponent(evalId)}`;
  return search.size > 0 ? `${path}?${search}` : path;
}

/** RC-294: a fix's page (E1), one of its simulations as a table (E4), and one eval of it (F2). */
export function fixPageHref(projectId: string, fixId: string): string {
  return `/project/${encodeURIComponent(projectId)}/improvement/fixes/${encodeURIComponent(fixId)}`;
}

export function fixSimulationHref(
  projectId: string,
  fixId: string,
  runId: string,
  filter?: "failing" | "changed",
): string {
  const path = `${fixPageHref(projectId, fixId)}/simulations/${encodeURIComponent(runId)}`;
  return filter ? `${path}?show=${filter}` : path;
}

export function fixTestHref(
  projectId: string,
  fixId: string,
  runId: string,
  evalId: string,
): string {
  return `${fixSimulationHref(projectId, fixId, runId)}/${encodeURIComponent(evalId)}`;
}

/** The status filter of the URL; anything else reads as all. */
export function parseEvalStatusFilter(value: unknown): EvalStatusFilter {
  return value === "suggested" ? "suggested" : null;
}
