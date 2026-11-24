import assert from "node:assert/strict";
import { test } from "node:test";
import { focusedStats, overviewStats } from "@/components/console/home/overview-stats";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  type Db,
  jobDeps,
  ORGANIZATION_ID,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { refreshTraceSummaries } from "@/lib/synthesis/traces/summary-refresh";
import { loadFocusedOverview } from "@/lib/views/home/focused-load";
import { loadOverview } from "@/lib/views/home/load";

/** The recap Overview says what the old Overview says: one seeded project, the same window. */

const NOW = new Date("2026-09-02T12:00:00Z");
const ORGANIZATION = { id: ORGANIZATION_ID, name: "Acme", slug: "acme" };
const PROJECT = { id: PROJECT_ID, name: "Agent", slug: "agent", isDemo: false };
const hex = (value: number, width: number) => value.toString(16).padStart(width, "0");

/** 40 runs over five days, and 25 in the window before; each tenth failed. */
function spans(): NewOtelSpan[] {
  return Array.from({ length: 65 }, (_, index) => {
    const daysAgo = index < 40 ? index % 5 : 8 + (index % 4);
    const startedAt = new Date(NOW.getTime() - daysAgo * 86_400_000 - (index + 1) * 60_000);
    return {
      id: `00000000-0000-4000-8000-${hex(index + 1, 12)}`,
      projectId: PROJECT_ID,
      receivedAt: startedAt,
      traceId: hex(index + 1, 32),
      spanId: hex(index + 1, 16),
      name: "invoke_agent main",
      kind: 1,
      spanClass: "other",
      experimentAttrs: {},
      attributes: {},
      attrsTruncated: false,
      startedAt,
      endedAt: new Date(startedAt.getTime() + 500 + index * 10),
      durationMs: 500 + index * 10,
      statusCode: index % 5 === 0 ? 2 : 1,
      costUsd: "0.010000",
    } as NewOtelSpan;
  });
}

async function seeded(): Promise<Db> {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [
    ...times(130, () =>
      fresh()
        .search(["create_task", "search_tasks"], { query: "find my open tasks" })
        .invoke("search_tasks"),
    ),
    ...times(25, () =>
      fresh()
        .search(["find_task"])
        .invoke("find_task")
        .search(["assign_task"])
        .invoke("assign_task"),
    ),
    ...times(6, () =>
      fresh()
        .search(["bulk_update"])
        .invoke("bulk_update")
        .error("bulk_update")
        .invoke("bulk_update")
        .error("bulk_update"),
    ),
  ]);
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  await insertOtelSpans(PROJECT_ID, spans(), db as never);
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db as never);
  return db;
}

test("the four values and the attention rows are the old Overview's", async () => {
  const db = await seeded();
  for (const window of [7, 30] as const) {
    const input = { project: PROJECT, organization: ORGANIZATION, window, now: NOW, db };
    const before = await loadOverview(input);
    const after = await loadFocusedOverview(input);
    assert.ok(before.traces && after.metrics && after.metrics !== "failed");
    assert.ok(before.traces.count >= 40 && before.traces.errorCount > 0);

    const old = overviewStats({ ...before, health: null }, before.traces);
    assert.deepEqual(
      old.map(({ label }) => label),
      ["Runs", "Failed runs", "Median duration", "Spend"],
    );
    assert.deepEqual(focusedStats(after.metrics), old);

    assert.ok(after.attention);
    const { items, moreIssues, healthHref, partial } = after.attention;
    assert.ok(items.some(({ key }) => key === "errors"));
    assert.ok(items.some(({ key }) => key.startsWith("issue:")));
    assert.deepEqual({ items, moreIssues }, before.attention);
    assert.equal(healthHref, before.health?.href);
    assert.equal(partial, false);
  }
});
