import assert from "node:assert/strict";
import { test } from "node:test";
import { TooltipProvider } from "@ratel/design-system/tooltip";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarContent, tourAnchor } from "@/components/console/shell/Sidebar";
import { consoleNav, flattenNav } from "@/lib/console/navigation";
import { isSpotlightable, resolveTourSteps, TOUR_STEPS } from "@/lib/console/onboarding/tour-steps";

/**
 * Owned (ADR-0030): upstream's cases, with the project rail read from `consoleNav` (stage spine
 * off and on), and one more that renders the sidebar and looks for each step's anchor.
 */

test("every declared step names a distinct id and a target", () => {
  const ids = new Set(TOUR_STEPS.map((step) => step.id));
  assert.equal(ids.size, TOUR_STEPS.length, "step ids must be unique");
  for (const step of TOUR_STEPS) {
    assert.ok(step.target.length > 0, `${step.id} needs a target`);
    assert.ok(step.title.length > 0, `${step.id} needs a title`);
    assert.ok(step.body.length > 0, `${step.id} needs a body`);
  }
});

// A step whose element is absent would spotlight a hole in the middle of the
// screen and explain something the reader cannot see.
test("steps whose target is missing are dropped, in order", () => {
  const present = new Set(["nav-overview", "nav-catalog", "command-palette"]);

  const resolved = resolveTourSteps(TOUR_STEPS, (target) => present.has(target));

  assert.deepEqual(
    resolved.map((step) => step.id),
    ["v2-overview", "v2-catalog", "command-palette"],
  );
});

// One step per rail item, in rail order, then the search every page shares.
test("the tour walks the rail in its own order", () => {
  const rail = new Set([
    "nav-overview",
    "agent-health",
    "nav-traces",
    "nav-catalog",
    "nav-quality",
    "command-palette",
  ]);

  assert.deepEqual(
    resolveTourSteps(TOUR_STEPS, (target) => rail.has(target)).map((step) => step.id),
    ["v2-overview", "agent-health", "v2-traces", "v2-catalog", "v2-quality", "command-palette"],
  );
});

// The rail anchors each item as `nav-<id>`, so a renamed item would silently
// drop its step: every navigation step must name an item the rail can render.
test("every navigation step names an item of the project rail", () => {
  const navSteps = TOUR_STEPS.filter((step) => step.target.startsWith("nav-"));
  assert.deepEqual(
    navSteps.map((step) => step.target),
    ["nav-overview", "nav-traces", "nav-catalog", "nav-quality"],
  );
  for (const stageSpine of [false, true]) {
    const rail = consoleNav({ projectId: "project", additions: [], stageSpine });
    const anchors = new Set(flattenNav(rail).map((item) => `nav-${item.id}`));
    for (const step of navSteps)
      assert.ok(
        anchors.has(step.target),
        `${step.id} points at ${step.target}, which the rail does not render (stage spine ${stageSpine})`,
      );
  }
});

// The anchors are attributes the sidebar writes: a step is only as good as the markup it finds.
test("the sidebar renders an anchor for every step that is not about the demo project", () => {
  const router = {
    back() {},
    forward() {},
    prefetch() {},
    push() {},
    replace() {},
    refresh() {},
  } as unknown as AppRouterInstance;
  const project = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Agent",
    organizationId: "o1",
    slug: "agent",
    isDemo: false,
  };
  const sidebar = (collapsed: boolean, stageSpine: boolean) => {
    const items = consoleNav({ projectId: project.id, additions: [], stageSpine });
    return renderToStaticMarkup(
      createElement(
        AppRouterContext.Provider,
        { value: router },
        createElement(
          PathnameContext.Provider,
          { value: `/project/${project.id}` },
          createElement(
            SearchParamsContext.Provider,
            { value: new URLSearchParams() },
            createElement(
              TooltipProvider,
              null,
              createElement(SidebarContent, {
                items,
                activeId: "overview",
                organizationName: "Acme",
                organizationSlug: "acme",
                projects: [project],
                project,
                account: null,
                collapsed,
                onSearch() {},
                onShortcuts() {},
              }),
            ),
          ),
        ),
      ),
    );
  };
  const steps = TOUR_STEPS.filter((step) => !step.demoOnly);
  for (const stageSpine of [false, true]) {
    const html = sidebar(false, stageSpine);
    for (const step of steps)
      assert.match(
        html,
        new RegExp(`data-tour="${step.target}"`),
        `${step.id}: no ${step.target} anchor in the rail (stage spine ${stageSpine})`,
      );
  }
  // Collapsed, the rail is icons only: the top-level items and the search keep their anchors.
  const collapsed = sidebar(true, false);
  for (const target of ["nav-overview", "agent-health", "nav-traces", "nav-catalog"])
    assert.match(collapsed, new RegExp(`data-tour="${target}"`));
  assert.match(collapsed, /data-tour="command-palette"/);
  assert.equal(tourAnchor({ id: "health" } as Parameters<typeof tourAnchor>[0]), "agent-health");
});

test("a page with no tour targets resolves to no steps", () => {
  assert.deepEqual(
    resolveTourSteps(TOUR_STEPS, () => false),
    [],
  );
});

test("the demo step is the only one gated on the demo project", () => {
  const demoOnly = TOUR_STEPS.filter((step) => step.demoOnly);
  assert.deepEqual(
    demoOnly.map((step) => step.id),
    ["demo-notice"],
  );
});

// The rail renders the anchor only while `cloud-agent-health` is on, so a
// project without the flag gets the tour without it, unchanged otherwise.
test("the Agent health step runs only when its anchor is on the page", () => {
  const withoutFlag = new Set(["nav-overview", "nav-traces", "nav-catalog"]);
  const withFlag = new Set([...withoutFlag, "agent-health"]);

  assert.deepEqual(
    resolveTourSteps(TOUR_STEPS, (target) => withoutFlag.has(target)).map((step) => step.id),
    ["v2-overview", "v2-traces", "v2-catalog"],
  );
  assert.deepEqual(
    resolveTourSteps(TOUR_STEPS, (target) => withFlag.has(target)).map((step) => step.id),
    ["v2-overview", "agent-health", "v2-traces", "v2-catalog"],
  );
});

test("the Agent health step targets its own anchor and is not demo-only", () => {
  const step = TOUR_STEPS.find((candidate) => candidate.id === "agent-health");
  assert.ok(step);
  assert.equal(step.target, "agent-health");
  assert.ok(!step.demoOnly);
});

// A folded submenu keeps its links in the DOM with a real height, clipped to
// nothing: spotlighting one draws a hole around an invisible row.
test("a target needs a box and must not sit in a folded subtree", () => {
  assert.equal(isSpotlightable({ width: 200, height: 32 }, false), true);
  assert.equal(isSpotlightable({ width: 200, height: 32 }, true), false);
  assert.equal(isSpotlightable({ width: 0, height: 0 }, false), false);
  assert.equal(isSpotlightable({ width: 200, height: 0 }, false), false);
});
