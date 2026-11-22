import { sql } from "drizzle-orm";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import {
  type ReplyExcerpt,
  replyExcerpt,
  replyTextOf,
} from "@/lib/readings/trace-signals/self-corrections/replies";
import { TRAILING_ASSISTANT } from "@/lib/readings/trace-signals/self-corrections/run-queries";

/**
 * One example's words, read on demand (`GET /api/projects/:projectId/
 * self-corrections/:correctionId/example`): the phrase a row points at and
 * the words around it, read back from the captured reply (content capture),
 * for a signed-in member of the project. Nothing is stored: the row keeps a
 * pointer and the range, and the reply is read at the moment it is shown.
 * Captured events are pruned after 30 days, so an older example says so.
 *
 * A route rather than a Server Action, for the reason the run Panel gives
 * (`lib/traces/v2/run-summary-route.ts`): a plain GET under `/api` is a read
 * and never re-renders the page.
 */

export type ExampleResult =
  | {
      ok: true;
      example: ({ state: "read" } & ReplyExcerpt) | { state: "expired" } | { state: "no_text" };
    }
  | { ok: false; message: string };

export interface ExampleRow {
  sourceEventId: string | null;
  matchStart: number | null;
  matchEnd: number | null;
}

/** The row's pointer, only within the project. */
export async function loadExampleRow(
  db: BoundReadDb,
  projectId: string,
  correctionId: string,
): Promise<ExampleRow | null> {
  const result = await db.execute<{
    source_event_id: string | null;
    match_start: number | null;
    match_end: number | null;
  }>(sql`
    select source_event_id, match_start, match_end from trace_self_corrections
    where id = ${correctionId} and project_id = ${projectId}`);
  const row = result.rows[0];
  return row
    ? { sourceEventId: row.source_event_id, matchStart: row.match_start, matchEnd: row.match_end }
    : null;
}

/** The captured call's trailing assistant messages (its reply), or null when the event is gone. */
export async function loadReplyMessages(
  db: BoundReadDb,
  projectId: string,
  eventId: string,
): Promise<unknown | null> {
  const result = await db.execute<{ reply: unknown }>(sql`
    select r.reply from events ev cross join lateral (${TRAILING_ASSISTANT}) r
    where ev.id = ${eventId} and ev.project_id = ${projectId}`);
  const row = result.rows[0];
  if (!row) return null;
  return typeof row.reply === "string" ? JSON.parse(row.reply) : row.reply;
}

export interface ExampleRouteDeps {
  getSession: () => Promise<{ userId: string; externalId: string } | null>;
  findProject: (
    projectId: string,
    userId: string,
  ) => Promise<{ projectId: string; organizationId: string } | null>;
  /** The row's pointer and, when it points at a captured event still kept, that call's reply messages. */
  loadExample: (
    projectId: string,
    correctionId: string,
  ) => Promise<{ row: ExampleRow | null; reply: unknown | null }>;
  setLogContext: (context: { project_id: string; org_id: string; distinct_id: string }) => void;
  logError: (fields: Record<string, unknown>, message: string) => void;
  reportException: (
    error: unknown,
    distinctId: string,
    properties: Record<string, unknown>,
  ) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND: ExampleResult = { ok: false, message: "This example isn't available." };

/** What the example shows, from the row and the reply read back. */
export function exampleOf(row: ExampleRow, reply: unknown | null): ExampleResult {
  if (!row.sourceEventId || row.matchStart === null || row.matchEnd === null)
    return { ok: true, example: { state: "no_text" } };
  const text = reply === null ? null : replyTextOf(reply);
  const excerpt = text === null ? null : replyExcerpt(text, row.matchStart, row.matchEnd);
  return excerpt
    ? { ok: true, example: { state: "read", ...excerpt } }
    : { ok: true, example: { state: "expired" } };
}

export async function exampleResponse(
  params: { projectId: string; correctionId: string },
  deps: ExampleRouteDeps,
): Promise<Response> {
  if (!UUID.test(params.correctionId)) return json(404, NOT_FOUND);
  const session = await deps.getSession();
  if (!session) return json(401, { ok: false, message: "Sign in to see this example." });
  // Not a member reads exactly like a missing project: nothing to probe.
  const project = await deps.findProject(params.projectId, session.userId);
  if (!project) return json(404, NOT_FOUND);
  deps.setLogContext({
    project_id: project.projectId,
    org_id: project.organizationId,
    distinct_id: session.externalId,
  });
  try {
    const { row, reply } = await deps.loadExample(project.projectId, params.correctionId);
    if (!row) return json(404, NOT_FOUND);
    return json(200, exampleOf(row, reply));
  } catch (err) {
    deps.logError({ err, project_id: project.projectId }, "self correction example load failed");
    deps.reportException(err, `project:${project.projectId}`, {
      operation: "self_correction_example",
      project_id: project.projectId,
    });
    return json(500, { ok: false, message: "Couldn't load this example. Try again in a moment." });
  }
}

function json(status: number, body: ExampleResult): Response {
  // The agent's own words, per member: never shared, never stored.
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
