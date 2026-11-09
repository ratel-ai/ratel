// What Ratel Cloud answers for each parity subject (temporary parity harness, RTL-45).
// Loaded only by capture.mts, with the Cloud checkout's apps/web as the working directory, so
// every '@/…' below is Cloud's code. The inputs come from this repository's parity/inputs.ts:
// the tests feed the same values to this repository's code.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE_DIFF_LINES } from "@/components/health/capture-nudge-model";
import { TOOL_CATALOG_SNIPPET } from "@/lib/catalogs/sync-snippet";
import { drainCron, type DrainCronDeps } from "@/lib/cron/drain";
import { createMigratedPGlite } from "@/lib/db/test-support";
import { buildFixes } from "@/lib/fixes/build";
import { fixSavingsText, savingsForPeriod } from "@/lib/fixes/period";
import { CRAFTS, fixesInput } from "@/lib/fixes/test-fixtures";
import { ANALYSIS_SECTIONS } from "@/lib/freshness/sections";
import { activeNavItemId, commandEntries, organizationNav, organizationRoot, projectNav, projectRoot, type NavItem, type NavSection } from "@/lib/navigation/v2";
import { resolveSelfTelemetryConfig } from "@/lib/otel/config";
import { handleTracesRequest } from "@/lib/otlp/route-handler";
import { buildQuickstartSet } from "@/lib/quickstart";
import { searchCommands } from "@/lib/scope/command-search";
import { legacyRouteRedirect } from "@/lib/scope/legacy-redirects";
import { renderSiteCopilotOtlp, SITE_COPILOT_DAYS } from "@/lib/seed/site-copilot-otlp";
import { planSiteCopilot } from "@/lib/seed/site-copilot-plan";
import { isImportedSourceId } from "@/lib/trace-signals/constants";
import * as inputs from "../../apps/web/parity/inputs.ts";
import { calledBy, sourceFacts, type SourceTree } from "../../apps/web/parity/source-probes.ts";

type Json = unknown;

const cloudTree: SourceTree = {
  read: (path) => (existsSync(join(process.cwd(), path)) ? readFileSync(join(process.cwd(), path), "utf8") : ""),
};

/** JSON as it will be stored: Maps and Dates turned into what a test can rebuild them from. */
function plain(value: unknown): Json {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (v instanceof Map ? { $map: [...v.entries()] } : v)),
  );
}

// ── navigation, ⌘K ────────────────────────────────────────────────────────────────────────

function railRows(sections: readonly NavSection[]) {
  const row = (item: NavItem, extra: Record<string, string>) => ({
    id: item.id,
    label: item.label,
    href: item.href,
    ...(item.exact ? { exact: true } : {}),
    ...(item.also ? { also: item.also } : {}),
    ...(item.shortcut ? { shortcut: item.shortcut } : {}),
    ...(item.keywords ? { keywords: item.keywords } : {}),
    ...(item.activeId ? { activeId: item.activeId } : {}),
    ...extra,
  });
  return sections.flatMap((section) =>
    section.items.flatMap((item, index) => [
      row(item, index === 0 && section.label ? { sectionLabel: section.label } : {}),
      ...(item.children ?? []).map((child) => row(child, { parent: item.id })),
    ]),
  );
}

function navigation() {
  const organization = { slug: inputs.ORGANIZATION_SLUG, options: { billing: true } };
  const shells = {
    project: {
      sections: projectNav(inputs.PROJECT_ID),
      root: projectRoot(inputs.PROJECT_ID),
      paths: inputs.PROJECT_PATHS,
      entries: commandEntries({ project: { id: inputs.PROJECT_ID, stageSpine: false }, organization }),
    },
    "project+stageSpine": {
      sections: projectNav(inputs.PROJECT_ID, { stageSpine: true }),
      root: projectRoot(inputs.PROJECT_ID),
      paths: inputs.PROJECT_PATHS,
      entries: commandEntries({ project: { id: inputs.PROJECT_ID, stageSpine: true }, organization }),
    },
    organization: {
      sections: organizationNav(organization.slug, organization.options),
      root: organizationRoot(organization.slug),
      paths: inputs.ORGANIZATION_PATHS,
      entries: commandEntries({ organization }),
    },
  } satisfies Record<inputs.NavScope, unknown>;
  return Object.fromEntries(
    Object.entries(shells).map(([scope, shell]) => [
      scope,
      {
        rail: railRows(shell.sections),
        active: Object.fromEntries(shell.paths.map((path) => [path, activeNavItemId(`${shell.root}${path}`, shell.sections)])),
        commands: shell.entries,
        search: Object.fromEntries(
          inputs.COMMAND_QUERIES.map((query) => [query, searchCommands(shell.entries, query).slice(0, 40).map(({ id, href }) => ({ id, href }))]),
        ),
      },
    ]),
  );
}

// ── redirects ─────────────────────────────────────────────────────────────────────────────

const BASE = "https://console.example";

/** What a page's `redirect()` or `permanentRedirect()` says: Next throws it as a digest. */
async function thrownRedirect(run: () => Promise<unknown>): Promise<{ destination: string; status: number } | null> {
  try {
    await run();
  } catch (thrown) {
    const digest = (thrown as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) {
      const parts = digest.split(";");
      return { destination: parts.slice(2, -2).join(";"), status: Number(parts.at(-2)) };
    }
    throw thrown;
  }
  return null;
}

async function redirects() {
  const none = async () => null;
  const table: Record<string, Json> = {};
  for (const address of inputs.LEGACY_ADDRESSES) table[address] = await legacyRouteRedirect(new URL(address, BASE), none, none);
  const dashboard = new URL("/dashboard", BASE);
  for (const [key, value] of Object.entries(inputs.DASHBOARD_REQUEST)) dashboard.searchParams.set(key, value);
  const { default: IntentExtractionPage } = await import("@/app/(app)/project/[projectId]/improvement/intents/page");
  return {
    table,
    dashboard: await legacyRouteRedirect(dashboard, none, none),
    improvementIntents: await thrownRedirect(() => IntentExtractionPage({ params: Promise.resolve({ projectId: inputs.PROJECT_ID }) })),
  };
}

// ── Fixes ─────────────────────────────────────────────────────────────────────────────────

function fixes() {
  const cases = {
    base: fixesInput(),
    priced: fixesInput({
      crafts: CRAFTS.map((craft) => ({ ...craft, windowDays: inputs.FIXES_WINDOW_DAYS })),
      price: inputs.FIXES_PRICE,
      taskUsage: new Map(inputs.FIXES_TASK_USAGE),
    }),
    worseMerge: fixesInput({
      crafts: CRAFTS.map((craft) => (craft.id === "c-merge" ? { ...craft, backtest: inputs.WORSE_BACKTEST as never } : craft)),
    }),
  };
  return Object.fromEntries(Object.entries(cases).map(([name, input]) => [name, { input: plain(input), model: plain(buildFixes(input)) }]));
}

function savings() {
  return {
    savingsForPeriod: inputs.SAVINGS.flatMap(({ savings, windowDays }) =>
      inputs.SAVINGS_PERIOD_KEYS.map((period) => ({ savings, windowDays, period, result: savingsForPeriod(savings, windowDays, period) })),
    ),
    fixSavingsText: inputs.GAINS.flatMap((gain) =>
      inputs.SAVINGS_PERIOD_KEYS.map((period) => ({ gain, period, result: fixSavingsText(gain, period) })),
    ),
  };
}

// ── the drain ─────────────────────────────────────────────────────────────────────────────

/** Sentinel results, so a heartbeat value says which step reported it. The tests return the same. */
export const DRAIN_SENTINELS = {
  refreshQualitySnapshots: { skipped: false, projectsScanned: 101, calibrationsRolledUp: 102, daysWritten: 103, fingerprintsChanged: 104 },
  sweepMatchQuality: { skipped: false, projectsScanned: 201, runsEnqueued: 202 },
};

async function drainTick(retentionEnabled: boolean) {
  const called: string[] = [];
  const heartbeats: Record<string, unknown>[] = [];
  let next = 1_000;
  const step = <T,>(name: string, result: T) => async () => {
    called.push(name);
    return result;
  };
  const deps: DrainCronDeps = {
    enqueueDueQueryCategorizations: step("enqueueDueQueryCategorizations", { enqueued: 11 }),
    drainProjectJobs: step("drainProjectJobs", { done: 12, failed: 13 }),
    pruneExpiredOtelSpans: step("pruneExpiredOtelSpans", 14),
    pruneExpiredOtelLogs: step("pruneExpiredOtelLogs", 15),
    pruneExpiredRuntimeEvents: step("pruneExpiredRuntimeEvents", 16),
    pruneExpiredRuntimeEventRejects: step("pruneExpiredRuntimeEventRejects", 17),
    refreshTraceSummaries: step("refreshTraceSummaries", { spansScanned: 18, tracesRecomputed: 19, batches: 1, caughtUp: true, lockContended: false }),
    pruneExpiredTraceSummaries: step("pruneExpiredTraceSummaries", 20),
    refreshQualitySnapshots: step("refreshQualitySnapshots", DRAIN_SENTINELS.refreshQualitySnapshots) as never,
    sweepMatchQuality: step("sweepMatchQuality", DRAIN_SENTINELS.sweepMatchQuality) as never,
    pruneIntentGraphRevisions: step("pruneIntentGraphRevisions", 21),
    enqueueDueIntentGraphFolds: step("enqueueDueIntentGraphFolds", { enqueued: 22 }),
    enqueueDueIntentEngineRuns: step("enqueueDueIntentEngineRuns", { enqueued: 23 }),
    pruneWhatIfRuns: step("pruneWhatIfRuns", { pruned: 24, timedOut: 25 }),
    expireIntentEngineClusters: step("expireIntentEngineClusters", 26),
    retentionEnabled,
    observability: {
      trackServerEvent: (async (event: string, _context: unknown, properties: Record<string, unknown> | undefined) => {
        if (event === "cron_drain_completed") heartbeats.push(properties ?? {});
      }) as never,
      reportServerException: (() => {}) as never,
      now: () => (next += 10),
      logError: (() => {}) as never,
    },
    enqueueDueTraceTurnBuilds: step("enqueueDueTraceTurnBuilds", { enqueued: 27 }),
    sweepTraceSignals: step("sweepTraceSignals", { skipped: false, projectsScanned: 28, runsEnqueued: 29 }) as never,
  };
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    await drainCron(new Request(`${BASE}/api/cron/drain`), deps);
  } finally {
    if (saved !== undefined) process.env.CRON_SECRET = saved;
  }
  const heartbeat = heartbeats[0] ?? {};
  const { duration_ms: _duration, ...rest } = heartbeat as Record<string, unknown>;
  return { called, heartbeat: rest };
}

async function drain() {
  const on = await drainTick(true);
  const off = await drainTick(false);
  const sentinelValues = new Set(Object.values(DRAIN_SENTINELS).flatMap((result) => Object.values(result).filter((v) => typeof v === "number")));
  return {
    sentinels: DRAIN_SENTINELS,
    // The functions a tick calls only when the operator has turned retention on.
    retentionOnly: on.called.filter((name) => !off.called.includes(name)),
    // The heartbeat of a tick where every step ran, without its duration.
    heartbeat: on.heartbeat,
    // The heartbeat keys the quality snapshot and the match-quality sweep report under.
    qualityHeartbeat: Object.fromEntries(Object.entries(on.heartbeat).filter(([, value]) => sentinelValues.has(value as number))),
  };
}

// ── snippets ──────────────────────────────────────────────────────────────────────────────

function snippets() {
  const quickstart = buildQuickstartSet({ ...inputs.QUICKSTART_TARGET });
  const withCapture = buildQuickstartSet({ ...inputs.QUICKSTART_TARGET, captureContent: true });
  const context = CAPTURE_DIFF_LINES.filter((line) => !line.added && line.text.trim() !== "").map((line) => line.text);
  const lines = new Set(withCapture.typescript.code.split("\n"));
  return {
    toolCatalog: TOOL_CATALOG_SNIPPET,
    quickstart,
    quickstartWithCapture: withCapture,
    // The capture nudge shows a diff against the quickstart: its unchanged lines must be lines of it.
    nudgeContextInQuickstart: context.map((text) => ({ text, inQuickstart: lines.has(text) })),
  };
}

// ── the Site Copilot seed ─────────────────────────────────────────────────────────────────

/** What the seed's ingest calls would store, read off the route handler's own writes. */
async function seedPlan() {
  const plan = planSiteCopilot({ seed: inputs.SEED.seed, turns: inputs.SEED.turns });
  const rendered = renderSiteCopilotOtlp(plan, { anchorMs: Date.parse(inputs.SEED.anchor), days: SITE_COPILOT_DAYS });
  const traceEvents: Record<string, number> = {};
  let spans = 0;
  let events = 0;
  const organization = { id: "org", plan: "enterprise" };
  for (const body of rendered.batches) {
    const request = new Request("http://seed.local/v1/traces", {
      method: "POST",
      headers: { authorization: "Bearer seed", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await handleTracesRequest(request, {
      isDbConfigured: () => true,
      hashApiKey: () => "hash",
      findActiveApiKeyByHash: async () => ({ id: "key", projectId: inputs.PROJECT_ID }),
      touchApiKey: async () => {},
      insertEventsWithMetrics: async (_projectId: string, rows: readonly unknown[]) => {
        events += rows.length;
        return rows.length;
      },
      insertOtelSpans: async (_projectId: string, rows: readonly unknown[]) => {
        spans += rows.length;
        return rows.length;
      },
      insertTraceEvents: async (_projectId: string, rows: readonly { type: string }[]) => {
        for (const row of rows) traceEvents[row.type] = (traceEvents[row.type] ?? 0) + 1;
        return rows.length;
      },
      getOrganizationByProjectId: async () => organization,
      resetEventUsageIfElapsed: async () => organization,
      incrementEventUsage: async () => {},
      traceTurns: { isEnabled: async () => true, enqueueBuild: async () => {}, scheduleProjectDrain: () => {} },
      findRuntimeInvokes: async () => [],
    } as never);
    if (!response.ok) throw new Error(`the seed's batch was refused: ${response.status} ${await response.text()}`);
  }
  return {
    input: inputs.SEED,
    plan: plan.stats,
    rendered: rendered.stats,
    // Everything the seed stores comes from these batches: Cloud's seed sends nothing else.
    stored: { otelSpans: spans, events, traceEvents, traceEventsTotal: Object.values(traceEvents).reduce((a, b) => a + b, 0) },
  };
}

// ── small tables ──────────────────────────────────────────────────────────────────────────

function selfTelemetry() {
  return inputs.TELEMETRY_ENVIRONMENTS.map(({ name, deploymentEnvironment, env }) => ({
    name,
    config: resolveSelfTelemetryConfig(env, { deploymentEnvironment }),
  }));
}

function importedSource() {
  return inputs.SOURCE_IDS.map((id) => ({ id, imported: isImportedSourceId(id) }));
}

/** Storage options the migrations leave on the three OpenTelemetry tables. */
async function schemaFacts() {
  const client = await createMigratedPGlite();
  try {
    const result = await client.query<{ relname: string; reloptions: string[] | null }>(
      "select relname, reloptions from pg_class where relkind = 'r' and relname in ('otel_spans', 'otel_logs', 'otel_trace_summaries') order by relname",
    );
    return { tableOptions: Object.fromEntries(result.rows.map((row) => [row.relname, [...(row.reloptions ?? [])].sort()])) };
  } finally {
    await client.close();
  }
}

/** Where "New project" sends a person: the last redirect of the organization page's action. */
function newProject() {
  const text = cloudTree.read("app/(app)/org/[orgSlug]/actions.ts");
  const targets = [...text.matchAll(/redirect\(\s*[`"']([^`"'?$]+)/g)].map((match) => match[1]);
  return { destinationPath: targets.at(-1) ?? null };
}

// ── source facts ──────────────────────────────────────────────────────────────────────────

export async function cloudSubjects(): Promise<Record<string, Json>> {
  const drained = await drain();
  return {
    navigation: navigation(),
    "analysis-sections": ANALYSIS_SECTIONS,
    redirects: await redirects(),
    fixes: fixes(),
    savings: savings(),
    drain: { ...drained, retentionOnlyCalledByDrain: calledBy(cloudTree.read("lib/cron/drain.ts"), drained.retentionOnly) },
    snippets: snippets(),
    "seed-plan": await seedPlan(),
    "self-telemetry": selfTelemetry(),
    "imported-source": importedSource(),
    "schema-facts": await schemaFacts(),
    "new-project": newProject(),
    "source-facts": sourceFacts(cloudTree),
  };
}
