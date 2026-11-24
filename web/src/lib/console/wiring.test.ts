import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CAPTURE_DIFF_LINES } from "@/components/console/health/capture-nudge-model";
import { buildQuickstartSet } from "@/lib/console/onboarding/quickstart";
import { sectionJobKinds } from "@/lib/views/freshness/sections";

/**
 * What a page renders or a route calls, where the platform split audit (2026-11-09, against
 * Ratel at 2848c52c) found this edition not doing what upstream does and no unit test can
 * run the page: it needs a database and a session. One fact per place, read off the source.
 *
 * A source check, so it is a net, not a proof: it fails when the wiring is taken out, not when
 * the wired thing stops working. That part has its own tests. The two cases that can call the
 * code (the Tasks page's freshness, the capture nudge) do.
 */

const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const source = (path: string): string => readFileSync(join(APP_ROOT, path), "utf8");

/** Every `register.ts` under `lib`: the job handlers and drain steps, one registration per module. */
function registrations(dir = join(APP_ROOT, "lib")): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : registrations(full);
    return name === "register.ts" ? [readFileSync(full, "utf8")] : [];
  });
}

test("the Tasks page's freshness waits on the task scores, a job this edition runs", () => {
  assert.ok(sectionJobKinds("tasks").includes("score_tasks"));
});

test("the sidebar renders the analysis freshness line inside a project", () => {
  assert.match(source("components/console/shell/Sidebar.tsx"), /<AnalysisFreshness\b/);
});

test("project home decides whether to offer the guided tour", () => {
  assert.match(source("app/(console)/project/[projectId]/page.tsx"), /\bofferTour=/);
});

test("Settings › API keys renders the quickstart under the key list", () => {
  assert.match(source("components/console/settings/ApiKeysSettings.tsx"), /<SdkQuickstart\b/);
});

test('a turn page offers "run to test" behind the eval gate', () => {
  const page = source("app/(console)/project/[projectId]/traces/turns/[turnId]/page.tsx");
  assert.match(page, /<RunToTest\b/);
  assert.match(page, /\bevalGateEnabledFor\(/);
});

test("the trace span inspector is given the SDK events page to link to", () => {
  // The trace page reads its props through the loader get_trace's MCP view shares (MCP Apps).
  const loader = source("lib/views/traces/trace-view-props.ts");
  const root = loader.match(/runtimeEventsRoot:\s*([^,]*)/)?.[1]?.trim();
  assert.ok(root !== undefined && root !== "null", "runtimeEventsRoot is a path, not null");
  assert.match(root, /runtime-events/);
  // Upstream's switch for it is a constant that is always on.
  assert.match(loader, /const runtimeEventsEnabled = true;/);
});

test("Settings › Developer builds each SDK event's trace link", () => {
  const settings = source("components/console/settings/DeveloperSettings.tsx");
  assert.match(settings, /toSdkEventView\(/);
  assert.doesNotMatch(settings, /traceHref:\s*null/);
});

test("a project page asks for the last-project cookie when it names another project", () => {
  const layout = source("app/(console)/project/[projectId]/layout.tsx");
  assert.match(layout, /lastProjectDiffers\([^)]*\)\s*\?\s*<RememberProject\b/);
});

test("the project layout returns its page when no database is configured", () => {
  assert.match(
    source("app/(console)/project/[projectId]/layout.tsx"),
    /if \(!isDbConfigured\(\)\) return children/,
  );
});

test("project home and onboarding build the ingest address with the same function", () => {
  const text =
    source("components/console/home/OverviewPage.tsx") + source("app/onboarding/page.tsx");
  const builders = new Set(
    [...text.matchAll(/\b(\w+)\(\s*"\/(?:v1\/)?traces"\s*\)/g)].map((match) => match[1]),
  );
  assert.deepEqual([...builders], ["apiUrl"]);
});

test("the capture nudge's unchanged lines are lines of the quickstart it is a diff against", () => {
  const quickstart = new Set(
    buildQuickstartSet({
      endpoint: "https://ratel.example.com/v1/traces",
      serviceName: "site-copilot",
      captureContent: true,
    }).typescript.code.split("\n"),
  );
  const context = CAPTURE_DIFF_LINES.filter((line) => !line.added && line.text.trim() !== "");
  assert.ok(context.length > 0, "the nudge still shows context lines");
  for (const line of context) assert.ok(quickstart.has(line.text), line.text);
});

test("the playground rank route and the traces routes resolve the project through findProjectScope", () => {
  for (const route of [
    "app/api/playground/rank/route.ts",
    "app/api/projects/[projectId]/traces/[traceId]/summary/route.ts",
    "app/api/projects/[projectId]/traces/sessions/route.ts",
    "app/api/projects/[projectId]/traces/summary/route.ts",
  ]) {
    assert.match(source(route), /\bfindProjectScope\(/, route);
  }
});

test("the Sessions list page checks the project scope itself, as its two routes do", () => {
  assert.match(
    source("components/console/traces-sessions/SessionListPage.tsx"),
    /\brequireProjectScope\(projectId\)/,
  );
});

test("root metadata sets a title template on the product name, a description and an icon", () => {
  // The layout builds it per request (`generateMetadata`) from `siteMetadata`, on APP_NAME.
  assert.match(source("app/layout.tsx"), /siteMetadata\(APP_NAME,/);
  const metadata = source("lib/platform/site-metadata.ts");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder as it is written in the source file
  assert.equal(metadata.match(/template:\s*[`"']([^`"']*)[`"']/)?.[1], "%s · ${appName}");
  assert.match(metadata, /\bdescription:/);
  assert.match(metadata, /\bicons:/);
});

test("every job that works on one project runs in the project log context", () => {
  const kinds = new Set<string>();
  const wrapped =
    /\b([a-z_]+):\s*(?:\(job\)\s*=>\s*)?(?:inProjectLogContext|withProjectLogContext)\(/g;
  for (const text of registrations())
    for (const match of text.matchAll(wrapped)) kinds.add(match[1]);
  assert.deepEqual([...kinds].sort(), [
    "assign_topics",
    "cluster_intents",
    "draft_fix",
    "label_workflows",
    "match_quality_run",
    "simulate_task_eval",
    "what_if_step",
  ]);
});

test("startup lends the edition the onboarding service with the other core services", () => {
  assert.match(source("instrumentation.node.ts"), /\bonboarding: createOnboardingService\(\)/);
});

test('the playground page is headed "Test a search", under Catalog', () => {
  const page = source("app/(console)/project/[projectId]/playground/page.tsx");
  assert.match(page, /title="Test a search"/);
  assert.match(page, /crumbs=\{\[\{ label: "Catalog"/);
});

test("the shell hands the edition's overlays and palette actions to the frame, which mounts the overlays after the shortcuts dialog", () => {
  const shell = source("components/console/shell/ConsoleShell.tsx");
  assert.match(shell, /overlays: ConsoleOverlays \? <ConsoleOverlays \/> : null/);
  assert.match(shell, /commandActions: ui\?\.commandActions \?\? \[\]/);
  const frame = source("components/console/shell/AppFrame.tsx");
  assert.match(frame, /edition: data\.commandActions/);
  assert.match(frame, /<ShortcutsDialog [^\n]*\/>\s*\{data\.overlays\}\s*<Toaster \/>/);
});

test("the shell decides agentsPages per organization and the rail reads it (RP-28)", () => {
  assert.match(
    source("components/console/shell/ConsoleShell.tsx"),
    /entityPagesOrganizationIds\(organizations\)/,
  );
  assert.match(
    source("components/console/shell/AppFrame.tsx"),
    /entityPagesOrganizations\?\.includes\(organization\.id\)[\s\S]*consoleNav\(\{[\s\S]*entityPages,/,
  );
});

test("the shell decides sentimentAnalysis per organization and the rail reads it", () => {
  assert.match(
    source("components/console/shell/ConsoleShell.tsx"),
    /sentimentOrganizationIds\(organizations\)/,
  );
  assert.match(
    source("components/console/shell/AppFrame.tsx"),
    /sentimentOrganizations\?\.includes\(organization\.id\)[\s\S]*consoleNav\(\{[\s\S]*sentiment,/,
  );
});

test("Sentiment analysis and Root cause analysis are not found unless sentimentPageScope gives a project", () => {
  // The decision itself is tested in `views/traces/sentiment/page-scope.test.ts`.
  for (const page of [
    "app/(console)/project/[projectId]/traces/sentiment/page.tsx",
    "app/(console)/project/[projectId]/health/root-causes/page.tsx",
  ]) {
    const text = source(page);
    assert.match(
      text,
      /const scope = await sentimentPageScope\(projectId\);\s*if \(!scope\) notFound\(\);/,
      page,
    );
    assert.doesNotMatch(
      text,
      /getProjectScope\(/,
      `${page} reads its project only through the check`,
    );
  }
});
