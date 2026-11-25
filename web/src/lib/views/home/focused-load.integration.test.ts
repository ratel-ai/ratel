import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { focusedStats, overviewStats } from "@/components/console/home/overview-stats";
import { resetConfigForTests } from "@/config";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { defaultOverviewDeps, overviewOperations } from "@/lib/mcp/operations/overview";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
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
import { LOW_CONFIDENCE_FLOOR } from "@/lib/readings/trace-signals/view";
import { refreshTraceSummaries } from "@/lib/synthesis/traces/summary-refresh";
import {
  healthCard,
  loadFocusedOverview,
  withoutLowConfidence,
} from "@/lib/views/home/focused-load";
import { firstTryTile, loadOverview } from "@/lib/views/home/load";
import { readHealth } from "@/lib/views/home/overview-reads";
import { WIDGET_CATALOG } from "@/lib/views/overview-layout/domain/layout";

/** The recap Overview says what the old Overview says: one seeded project, the same window. */

const NOW = new Date("2026-09-02T12:00:00Z");
const ORGANIZATION = { id: ORGANIZATION_ID, name: "Acme", slug: "acme" };
const PROJECT = { id: PROJECT_ID, name: "Agent", slug: "agent", isDemo: false };
const INSIGHTS = process.env.FF_TOOL_RUN_INSIGHTS;
const setInsights = (value: string | undefined) => {
  if (value === undefined) delete process.env.FF_TOOL_RUN_INSIGHTS;
  else process.env.FF_TOOL_RUN_INSIGHTS = value;
  resetConfigForTests();
};
afterEach(() => setInsights(INSIGHTS));
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

/** 24 turns: below the old threshold, at or above the low-confidence floor. `runs`: traces too, else SDK events only. */
async function small(runs: boolean): Promise<Db> {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [
    ...times(18, () =>
      fresh()
        .search(["create_task", "search_tasks"], { query: "find my open tasks" })
        .invoke("search_tasks"),
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
  if (runs) {
    await insertOtelSpans(PROJECT_ID, spans(), db as never);
    await refreshTraceSummaries({ visibilityLagMs: 0 }, db as never);
  }
  return db;
}

for (const insights of ["1", "0"]) {
  test(`a small project, toolRunInsights=${insights}: the attention rows and the stats are the old Overview's`, async () => {
    setInsights(insights);
    for (const runs of [true, false]) {
      const db = await small(runs);
      for (const window of [7, 30] as const) {
        const input = { project: PROJECT, organization: ORGANIZATION, window, now: NOW, db };
        const before = await loadOverview(input);
        const after = await loadFocusedOverview(input);
        assert.ok(after.attention && after.health && after.metrics && after.metrics !== "failed");
        const { items, moreIssues } = after.attention;
        assert.ok(items.some(({ key }) => key.startsWith("issue:")));
        assert.deepEqual({ items, moreIssues }, before.attention);
        assert.equal(after.health.card.kind, insights === "1" ? "score" : "state");
        assert.ok(before.traces);
        assert.deepEqual(
          focusedStats(after.metrics),
          overviewStats(runs ? { ...before, health: null } : before, before.traces),
          runs ? "runs" : "SDK only",
        );
      }
    }
  });
}

test("a small project: the gauge is Agent health's reading, and the old reading is the one without the floor", async () => {
  const db = await small(true);
  for (const windowDays of [7, 30] as const) {
    const scope = {
      projectId: PROJECT_ID,
      organization: ORGANIZATION,
      current: { since: NOW, until: NOW },
      before: { since: NOW, until: NOW },
      now: NOW,
      db,
    };
    const limits = getAgentHealthLimits(ORGANIZATION);
    const early = await readHealth(scope, windowDays, limits, LOW_CONFIDENCE_FLOOR);
    const usual = await readHealth(scope, windowDays, limits);
    assert.ok(early.lowConfidence && !usual.lowConfidence);
    const derived = withoutLowConfidence(early);
    for (const key of ["signals", "lockedCount", "turns", "floor", "score"] as const)
      assert.deepEqual(derived[key], usual[key], key);
    assert.equal(firstTryTile(derived), firstTryTile(usual));

    setInsights("1");
    const page = await loadFocusedOverview({
      project: PROJECT,
      organization: ORGANIZATION,
      window: windowDays,
      now: NOW,
      db,
    });
    assert.deepEqual(page.health?.card, healthCard(early));
  }
});

test("get_overview has the attention rows of the web loader for a small project", async () => {
  const db = await small(true);
  for (const insights of ["1", "0"]) {
    setInsights(insights);
    for (const [range, window] of [
      ["7d", 7],
      ["30d", 30],
    ] as const) {
      const page = await loadFocusedOverview({
        project: PROJECT,
        organization: ORGANIZATION,
        window,
        now: NOW,
        db,
      });
      const [getOverview] = overviewOperations({
        ...defaultOverviewDeps,
        getProject: (async () => PROJECT) as never,
        getOrganization: async () => ORGANIZATION,
        focusedConsole: async () => true,
        offeredWidgets: async () => WIDGET_CATALOG,
        dashboardsOn: async () => false,
        loadOverview: (input) => loadFocusedOverview({ ...input, db }),
        now: () => NOW,
      });
      const { data } = await getOverview.execute(
        {
          auth: { kind: "api-key" } as McpAuthContext,
          projectId: PROJECT_ID,
          organizationId: ORGANIZATION_ID,
          logger: undefined as never,
        },
        { range },
      );
      const { attention } = data as {
        attention: { rows: { key: string; title: string; figure: string }[]; moreIssues: number };
      };
      assert.equal(attention.moreIssues, page.attention?.moreIssues);
      assert.deepEqual(
        attention.rows.map(({ key, title, figure }) => [key, title, figure]),
        page.attention?.items.map(({ key, title, figure }) => [
          key,
          title,
          `${figure.value} ${figure.caption}`,
        ]),
      );
    }
  }
});
