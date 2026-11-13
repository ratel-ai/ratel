import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import { loadCatalogNames } from "@/lib/readings/trace-signals/signals/analysis-context";
import { listOpenSignals } from "@/lib/readings/trace-signals/signals/queries";
import type { EvidenceTurn } from "@/lib/readings/trace-signals/view";
import { loadEvidenceTurns } from "@/lib/views/health/evidence";
import type { SignalRecord } from "@/lib/views/health/signals/claims-model";
import { toSignalRecord } from "@/lib/views/health/signals/page-view";

/**
 * An issue's example turns, read on demand (`GET /api/projects/:projectId/
 * health/examples?issues=<id>,<id>`) when a member opens the issue on Agent
 * health's Summary. The page itself carries no example: a turn's story can
 * hold what a user typed (a captured search), so it is read only when someone
 * asks to see it, only for a member of the project, and never stored or
 * cached. The plan decides how many turns an issue shows (0: none, the
 * examples are an upsell) and which issues are shown at all.
 */

export interface IssueExamples {
  /** The issue (`trace_signals.id`). */
  id: string;
  /** Turns behind the issue in all, of which `turns` is a sample. */
  total: number;
  /** Newest first, cut to the plan. */
  turns: EvidenceTurn[];
}

export type IssueExamplesResult =
  | { ok: true; locked: boolean; examples: IssueExamples[] }
  | { ok: false; message: string };

/** One request covers one issue row: a kind's worst members, never the whole list. */
export const MAX_ISSUES_PER_REQUEST = 30;

/** The most example turns an issue shows, whatever the plan allows. */
export const MAX_TURNS_PER_ISSUE = 12;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND: IssueExamplesResult = { ok: false, message: "These examples aren't available." };

/** The issue ids a request names: comma-separated ids, each once; null when any is malformed or there are none or too many. */
export function parseIssueIds(raw: string | null): string[] | null {
  if (!raw) return null;
  const ids = [
    ...new Set(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
  if (ids.length === 0 || ids.length > MAX_ISSUES_PER_REQUEST || !ids.every((id) => UUID.test(id)))
    return null;
  return ids;
}

/** Turns per issue on a plan: its allowance, capped; 0 when the plan shows none. */
export function turnsPerIssue(allowance: number): number {
  if (!Number.isFinite(allowance)) return allowance > 0 ? MAX_TURNS_PER_ISSUE : 0;
  return Math.min(MAX_TURNS_PER_ISSUE, Math.max(0, Math.floor(allowance)));
}

export interface ExampleLimits {
  /** Turns each issue shows (`turnsPerIssue`). */
  perIssue: number;
  /** Issues the plan shows, worst first (`agentHealthSignalsShown`). */
  shown: number;
}

/**
 * The stories of the requested issues, among the open ones the plan shows
 * (the same cut and order as the page). An id that is not one of them reads
 * as nothing: it is not this project's, not open, or past the plan.
 */
export async function readIssueExamples(
  db: BoundReadDb,
  projectId: string,
  ids: readonly string[],
  limits: ExampleLimits,
): Promise<IssueExamples[]> {
  const records = (await listOpenSignals(projectId, db))
    .map(toSignalRecord)
    .filter((record): record is SignalRecord => record !== null);
  const shown = Number.isFinite(limits.shown)
    ? records.slice(0, Math.max(0, Math.floor(limits.shown)))
    : records;
  const wanted = shown.filter((record) => ids.includes(record.id));
  if (wanted.length === 0) return [];
  const names = await loadCatalogNames(projectId, db);
  const stories = await loadEvidenceTurns(
    projectId,
    wanted.map((record) => ({
      signalId: record.id,
      kind: record.kind,
      subjectIds: record.subjectIds,
      turnIds: record.turnIds,
    })),
    limits.perIssue,
    names,
    db,
  );
  return wanted.map((record) => ({
    id: record.id,
    total: record.totalTurns,
    turns: stories.get(record.id) ?? [],
  }));
}

export interface IssueExamplesDeps {
  getSession: () => Promise<{ userId: string; externalId: string } | null>;
  /** The project for a member, with what the plan allows; null when not a member (or no such project). */
  findProject: (
    projectId: string,
    userId: string,
  ) => Promise<{ projectId: string; organizationId: string; limits: ExampleLimits } | null>;
  loadExamples: (
    projectId: string,
    ids: readonly string[],
    limits: ExampleLimits,
  ) => Promise<IssueExamples[]>;
  setLogContext: (context: { project_id: string; org_id: string; distinct_id: string }) => void;
  logError: (fields: Record<string, unknown>, message: string) => void;
  reportException: (
    error: unknown,
    distinctId: string,
    properties: Record<string, unknown>,
  ) => void;
}

/** The route's answer. A read: no product event. */
export async function issueExamplesResponse(
  projectId: string,
  rawIds: string | null,
  deps: IssueExamplesDeps,
): Promise<Response> {
  const ids = parseIssueIds(rawIds);
  if (!ids) return json(400, { ok: false, message: "Name the issues to read, by id." });
  const session = await deps.getSession();
  if (!session) return json(401, { ok: false, message: "Sign in to see these examples." });
  // Not a member reads exactly like a missing project: nothing to probe.
  const project = await deps.findProject(projectId, session.userId);
  if (!project) return json(404, NOT_FOUND);
  deps.setLogContext({
    project_id: project.projectId,
    org_id: project.organizationId,
    distinct_id: session.externalId,
  });
  // The plan shows no example turns: say so without reading any.
  if (project.limits.perIssue <= 0) return json(200, { ok: true, locked: true, examples: [] });
  try {
    const examples = await deps.loadExamples(project.projectId, ids, project.limits);
    return json(200, { ok: true, locked: false, examples });
  } catch (err) {
    deps.logError(
      { err, project_id: project.projectId, issues: ids.length },
      "issue examples load failed",
    );
    deps.reportException(err, `project:${project.projectId}`, {
      operation: "agent_health_issue_examples",
      project_id: project.projectId,
    });
    return json(500, {
      ok: false,
      message: "Couldn't load these examples. Try again in a moment.",
    });
  }
}

function json(status: number, body: IssueExamplesResult): Response {
  // A captured search is a user's own words: per member, never shared, never stored.
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
