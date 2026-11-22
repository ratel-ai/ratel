import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { typedStepFixtures } from "@/lib/ingest/otlp/__fixtures__/typed-steps";
import { persistDecodedSpans } from "@/lib/ingest/otlp/ingest-spans";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
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
import { loadHealthPageModel } from "@/lib/views/health/page-model";

const ORG = "22222222-2222-4222-8222-222222222222";
type Db = ReturnType<typeof getDb>;

test("real-shape OTLP ingest builds typed turns", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  try {
    await db.insert(organizations).values({ id: ORG, name: "Sample", slug: "sample" });
    for (const [name, spans] of Object.entries(typedStepFixtures(Date.now() - 3_600_000))) {
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, organizationId: ORG, name, slug: name });
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
          agentSpanDedupe: null,
          logError: () => {},
          captureFailure: () => {},
        },
      );
      assert.ok(result.ok);
      const tracked: string[] = [];
      const deps: Partial<BuildJobDeps> = {
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
        observability: {
          trackSystemEvent: async (event) => {
            tracked.push(event);
          },
        },
        salt: "test-salt",
      };
      await buildProjectTraceTurns(projectId, deps);
      assert.equal(tracked.includes("typed_steps_turn_built"), true);
      const page = await loadHealthPageModel({ projectId, windowDays: 7 }, "test", {
        db,
        getLimits: async () => ({
          agentHealthSignalsShown: 10,
          agentHealthEvidenceTurns: 0,
          agentHealthWindowDays: 7,
        }),
        getLabels: async () => new Map(),
        getInsights: async () => null,
      });
      assert.equal(page.waitingOn, undefined, `${name} health`);
      const turns = await db.select().from(traceTurns).where(eq(traceTurns.projectId, projectId));
      assert.equal(turns.length, name === "vibiz" ? 2 : 1, name);
      const steps = await db
        .select()
        .from(traceTurnSteps)
        .where(eq(traceTurnSteps.projectId, projectId))
        .orderBy(traceTurnSteps.occurredAt, traceTurnSteps.ordinal);
      const expected = {
        ratel: ["agent", "model_call"],
        bareChat: ["model_call"],
        stema: ["code", "model_call"],
        vibiz: [
          "agent",
          "code",
          "code",
          "model_call",
          "handoff",
          "model_call",
          "code",
          "agent",
          "model_call",
        ],
        cato: ["agent", "model_call", "invoke", "model_call"],
        docs: ["code", "code", "user_message", "model_call", "code", "user_message", "model_call"],
      };
      assert.deepEqual(
        steps.map((s) => s.kind),
        expected[name as keyof typeof expected],
        name,
      );
      assert.equal(
        turns.reduce((n, t) => n + t.invokeCount, 0),
        name === "cato" ? 1 : 0,
      );
      assert.equal(
        turns.reduce((n, t) => n + t.distinctTools, 0),
        name === "cato" ? 1 : 0,
      );
      const before = steps.map(({ id, ...s }) => s);
      await db
        .update(projects)
        .set({ traceTurnsBuiltThrough: null })
        .where(eq(projects.id, projectId));
      await buildProjectTraceTurns(projectId, deps);
      const rebuilt = await db
        .select()
        .from(traceTurnSteps)
        .where(eq(traceTurnSteps.projectId, projectId))
        .orderBy(traceTurnSteps.occurredAt, traceTurnSteps.ordinal);
      assert.deepEqual(
        rebuilt.map(({ id, ...s }) => s),
        before,
        `${name} rebuild`,
      );
    }
  } finally {
    await client.close();
  }
});
