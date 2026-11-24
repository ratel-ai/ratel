// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { GroupDonut } from "@/components/console/hallucinations/GroupDonut";
import { StatusRing } from "@/components/console/health/v2/StatusRing";
import { hallucinationsLinks } from "@/lib/views/health/hallucinations/page-links";
import {
  buildHallucinationsPage,
  type PageFinding,
} from "@/lib/views/health/hallucinations/page-model";
import { parseHallucinationsQuery } from "@/lib/views/health/hallucinations/paths";
import { render } from "@/lib/views/tasks/test-support";

/**
 * The two rings as a reader gets them before any pointing: what each slice
 * says, where it leads, what the middle says, and the arcs' share of the
 * circle. A slice of nothing is not drawn.
 */

const CIRCUMFERENCE = 2 * Math.PI * 46;

/** Each drawn arc's dash length, in order. */
const arcs = (html: string): number[] =>
  [...html.matchAll(/stroke-dasharray="([\d.]+) [\d.]+"/g)].map((match) => Number(match[1]));

test("the status ring: a slice per status with tasks, its link, and the total in the middle", () => {
  const html = render(
    createElement(StatusRing, {
      label: "Tasks by status",
      total: "75%",
      unit: "completed",
      slices: [
        { key: "completed", label: "Completed", value: 3, share: 0.75, color: "#0a0", href: null },
        {
          key: "friction",
          label: "After friction",
          value: 1,
          share: 0.25,
          color: "#aa0",
          href: "/rc?x=1",
        },
        {
          key: "not_completed",
          label: "Not completed",
          value: 0,
          share: 0,
          color: "#a00",
          href: "/rc?x=2",
        },
      ],
    }),
  );
  assert.match(html, /aria-label="Tasks by status: Completed 75%, After friction 25%"/);
  assert.deepEqual(
    [...html.matchAll(/data-status-ring-slice="([a-z_]+)"/g)].map((match) => match[1]),
    ["completed", "friction"],
    "a status with no task has no slice",
  );
  assert.match(html, /<a[^>]*data-status-ring-slice="friction"[^>]*href="\/rc\?x=1"/);
  assert.match(html, /<g[^>]*tabindex="0"[^>]*data-status-ring-slice="completed"/);
  assert.match(html, /data-status-ring-middle=""[^]*75%[^]*completed/);
  const [completed, friction] = arcs(html);
  // Each arc is its share of the circle, less the gap between two slices.
  assert.ok(Math.abs(completed! - (0.75 * CIRCUMFERENCE - 2)) < 0.01);
  assert.ok(Math.abs(friction! - (0.25 * CIRCUMFERENCE - 2)) < 0.01);
});

function finding(kind: string, i: number): PageFinding {
  return {
    id: `f-${kind}-${i}`,
    turnId: `t-${i}`,
    sessionId: `s-${i}`,
    stepOrdinal: 1,
    eventId: null,
    kind,
    toolId: "update_task",
    requestedToolId: null,
    repeats: 1,
    worked: false,
    occurredAt: new Date(Date.UTC(2026, 8, 1, 9, i)),
  };
}

test("the group ring: a linked slice per group with findings, the groups beside it, the count in the middle", () => {
  const model = buildHallucinationsPage(
    {
      projectId: "p1",
      windowDays: 30,
      findings: [
        finding("unknown_reference", 1),
        finding("unknown_reference", 2),
        finding("unknown_reference", 3),
        finding("unknown_tool", 4),
      ],
      turns: 100,
      lastReadAt: new Date("2026-09-02T00:00:00Z"),
      capped: false,
    },
    parseHallucinationsQuery({}),
  );
  const html = render(createElement(GroupDonut, { links: hallucinationsLinks(model), total: 4 }), {
    pathname: "/project/p1/health/hallucinations",
  });
  assert.deepEqual(
    [...html.matchAll(/data-hallucination-slice="([a-z]+)"/g)].map((match) => match[1]),
    ["tool", "input"],
    "a group with no finding has no slice",
  );
  assert.match(
    html,
    /aria-label="Hallucinations by group: Tool hallucinations 25%, Input hallucinations 75%"/,
  );
  assert.match(
    html,
    /<a[^>]*data-hallucination-slice="input"[^>]*href="\/project\/p1\/health\/hallucinations\?group=input"/,
  );
  assert.match(html, /data-hallucination-donut-middle=""[^]*>4<[^]*hallucinations/);
  // Every group is listed beside the ring, the empty one too.
  assert.deepEqual(
    [...html.matchAll(/data-hallucination-group="([a-z]+)"/g)].map((match) => match[1]),
    ["tool", "input", "completion"],
  );
  const [tool, input] = arcs(html);
  assert.ok(Math.abs(tool! - (0.25 * CIRCUMFERENCE - 2)) < 0.01);
  assert.ok(Math.abs(input! - (0.75 * CIRCUMFERENCE - 2)) < 0.01);
});
