import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { typedStepFixtures } from "@/lib/ingest/otlp/__fixtures__/typed-steps";
import { persistDecodedSpans } from "@/lib/ingest/otlp/ingest-spans";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { traceTurns } from "@/lib/ledger/schema";
import { type BuildJobDeps, buildProjectTraceTurns } from "@/lib/ledger/turns/build-job";
import {
  closeIdleTraceTurns,
  getTraceTurnsCursor,
  listTurnEventHits,
  listTurnEventsPage,
  loadReloadableTurns,
  writeTurnPage,
} from "@/lib/ledger/turns/queries";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite, organizations } from "@/lib/platform/db/test-support";
import { projects } from "@/lib/platform/projects/schema";

const ORG = "33333333-3333-4333-8333-333333333333";
type Db = ReturnType<typeof getDb>;

test("traces without a session id each get their own session", async () => {
  await withProject(async (db, projectId) => {
    // A conversation trace first: the project then has a session that a bad lookup could hand to every trace.
    const conversation = copyTrace(
      typedStepFixtures(Date.now() - 3_700_000).cato,
      "e5",
      "conversation-zero",
    );
    const [first, second] = [copyTrace(stema(), "a1", null), copyTrace(stema(), "b2", null)];
    await ingestAndBuild(db, projectId, [...conversation, ...first, ...second]);
    const turns = await loadTurns(db, projectId);
    assert.equal(turns.length, 3);
    assert.deepEqual(
      turns.map((t) => t.sessionId).sort(),
      ["conversation-zero", first[0].traceId, second[0].traceId].sort(),
    );
  });
});

test("child-span conversation ids give each trace its own session", async () => {
  await withProject(async (db, projectId) => {
    const first = copyTrace(
      typedStepFixtures(Date.now() - 3_600_000).cato,
      "c3",
      "conversation-one",
    );
    const second = copyTrace(
      typedStepFixtures(Date.now() - 3_500_000).cato,
      "d4",
      "conversation-two",
    );
    await ingestAndBuild(db, projectId, [...first, ...second]);
    const turns = await loadTurns(db, projectId);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((t) => t.sessionId).sort(), [
      "conversation-one",
      "conversation-two",
    ]);
  });
});

function stema(): DecodedSpan[] {
  return typedStepFixtures(Date.now() - 3_600_000).stema;
}

/** Give a fixture trace a fresh trace id and, if set, a fresh conversation id on the spans that carry one. */
function copyTrace(
  spans: DecodedSpan[],
  tag: string,
  conversationId: string | null,
): DecodedSpan[] {
  const traceId = tag.repeat(16);
  return spans.map((span) => ({
    ...span,
    traceId,
    spanId: `${tag}${span.spanId.slice(2)}`,
    parentSpanId: span.parentSpanId ? `${tag}${span.parentSpanId.slice(2)}` : null,
    attributes:
      conversationId && span.attributes["gen_ai.conversation.id"]
        ? { ...span.attributes, "gen_ai.conversation.id": conversationId }
        : span.attributes,
  }));
}

async function withProject(run: (db: Db, projectId: string) => Promise<void>): Promise<void> {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  try {
    const projectId = randomUUID();
    await db.insert(organizations).values({ id: ORG, name: "Sample", slug: "sample" });
    await db
      .insert(projects)
      .values({ id: projectId, organizationId: ORG, name: "sessions", slug: "sessions" });
    await run(db, projectId);
  } finally {
    await client.close();
  }
}

async function ingestAndBuild(db: Db, projectId: string, spans: DecodedSpan[]): Promise<void> {
  const result = await persistDecodedSpans(
    spans,
    { projectId, organization: null, endpoint: "/v1/traces" },
    {
      insertEventsWithMetrics: async (_p, rows) => rows.length,
      insertTraceEvents: (p, rows) => insertTraceEvents(p, rows, db),
      insertOtelSpans: (p, rows, _db, options) => insertOtelSpans(p, rows, db, options),
      traceTurns: {
        enqueueBuild: async () => null,
        scheduleProjectDrain: () => {},
      },
      agentRunsEnabled: async () => false,
      typedStepsEnabled: async () => true,
      agentSpanDedupe: null,
      logError: () => {},
      captureFailure: () => {},
    },
  );
  assert.ok(result.ok);
  const deps: Partial<BuildJobDeps> = {
    readsAgentRuns: async () => false,
    readsTypedSteps: async () => true,
    getCursor: (p) => getTraceTurnsCursor(p, db),
    listEvents: (p, since, _db, limit, types) => listTurnEventsPage(p, since, db, limit, types),
    listHits: (ids) => listTurnEventHits(ids, db),
    loadTurns: (p, sessions, keys, reach) => loadReloadableTurns(p, sessions, keys, reach, db),
    writePage: (input) => writeTurnPage(input, db),
    closeIdle: (p, before, now) => closeIdleTraceTurns(p, before, now, db),
    enqueueBuild: async () => null,
    enqueueReading: async () => null,
    onBacklogDrained: async () => null,
    onBacklogProgress: async () => null,
    observability: { trackSystemEvent: async () => {} },
    salt: "test-salt",
  };
  await buildProjectTraceTurns(projectId, deps);
}

async function loadTurns(db: Db, projectId: string) {
  return db.select().from(traceTurns).where(eq(traceTurns.projectId, projectId));
}
