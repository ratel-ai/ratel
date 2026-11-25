// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { TopologyMap } from "@/components/console/topology/TopologyMap";
import type { TracesSeen } from "@/lib/views/home/focused-load";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import { findDsViolations } from "../../../../eslint-rules/ds-tokens.mjs";
import { type Topology, topologyModel } from "./topology";

const ROWS = {
  agents: [
    { key: "main", displayName: "Main agent", calls: 20, errorRate: 0.3 },
    { key: "sub", displayName: "Sub agent", calls: 1, errorRate: 0 },
  ],
  handoffs: [{ from: "main", to: "sub", fromName: "Main agent", toName: "Sub agent", count: 4 }],
  servers: [
    { key: "board", role: "consumed" as const, displayName: "board", calls: 9, errorRate: 0 },
  ],
  calls: [{ agent: "sub", server: "board", calls: 9, errors: 2 }],
  hidden: new Set<string>(),
  names: new Map<string, string>(),
};
const GRAPH = topologyModel(ROWS);

const map = (graph: Topology, linked: boolean, tracesSeen: TracesSeen | null = "in_window") =>
  render(
    createElement(TopologyMap, {
      projectId: PROJECT_ID,
      graph,
      range: "7d",
      linked,
      empty: { root: `/project/${PROJECT_ID}`, window: 7, tracesSeen },
    }),
  );

test("nodes, counts and flows, with a title for each edge and a text list", () => {
  const html = map(GRAPH, true);
  const text = visibleText(html);
  for (const words of [
    "20 runs, 30% errors",
    "Main agent hands work to Sub agent: 4 handoffs",
    "Sub agent calls board: 9 calls, 2 errors",
  ])
    assert.ok(text.includes(words), words);
  assert.equal((html.match(/<title>/g) ?? []).length, GRAPH.nodes.length + GRAPH.edges.length);
  assert.match(html, /<ul class="sr-only" aria-label="Agents, MCP servers and their flows">/);
  const violations = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => findDsViolations(m[1]));
  assert.deepEqual(violations, []);
  assert.doesNotMatch(text, /—/);
});

test("with the pages on, the nodes and See all open them in the window", () => {
  const hrefs = [...map(GRAPH, true).matchAll(/href="([^"]+)"/g)].map((match) => match[1]).sort();
  const root = `/project/${PROJECT_ID}`;
  assert.deepEqual(
    hrefs,
    [
      `${root}/agents/main?range=7d`,
      `${root}/agents/sub?range=7d`,
      `${root}/agents?range=7d`,
      `${root}/mcp/board?range=7d`,
      `${root}/mcp?range=7d`,
    ].sort(),
  );
});

test("with the pages off, nothing is a link", () => {
  assert.doesNotMatch(map(GRAPH, false), /<a\b|href=/);
});

test("MCP only says that no span names an agent", () => {
  const graph = topologyModel({ ...ROWS, agents: [], handoffs: [], calls: [] });
  const text = visibleText(map(graph, true));
  assert.match(text, /No span names an agent/);
  assert.doesNotMatch(text, /See all agents/);
});

test("nothing yet is a designed state", () => {
  const graph = topologyModel({ ...ROWS, agents: [], handoffs: [], servers: [], calls: [] });
  for (const seen of ["in_window", null] as const) {
    const text = visibleText(map(graph, true, seen));
    assert.match(
      text,
      /No agents or MCP servers in this window.*gen_ai\.agent\.name.*Set up tracing/,
    );
  }
  const none = map(graph, true, "none");
  assert.match(visibleText(none), /No traces yet.*Send traces.*Set up tracing/);
  assert.match(
    visibleText(map(graph, true, "before")),
    /No traces in the last 7 days.*Show 30 days/,
  );
});

test("the example map is the real drawing, and never reads as data", () => {
  const none = map(
    topologyModel({ ...ROWS, agents: [], handoffs: [], servers: [], calls: [] }),
    true,
    "none",
  );
  const svgs = [
    ...none.matchAll(/<svg[^>]*data-topology-example="([^"]+)"[^>]*>([\s\S]*?<\/g>)<\/svg>/g),
  ];
  assert.deepEqual(
    svgs.map((svg) => svg[1]),
    ["wide", "full", "row", "tall", "pair"],
  );
  for (const [svg, size] of svgs) {
    assert.match(svg, /aria-hidden="true"/, size);
    assert.match(svg, /data-topology-node="agent"[\s\S]*data-topology-node="mcp"/, size);
    assert.match(svg, /data-topology-edge="call"/, size);
    assert.doesNotMatch(
      svg,
      /<a\b|href=|<title>|color-danger|animate-/,
      `${size} is still and inert`,
    );
    assert.doesNotMatch(svg.replace(/<[^>]+>/g, " "), /\d/, `${size} has no number`);
  }
  const words = svgs[0][0].replace(/<[^>]+>/g, "|");
  for (const name of ["Your agent", "Research agent", "Support agent", "Search", "CRM", "Database"])
    assert.ok(words.includes(name), name);
  assert.match(none, /aria-hidden="true"[^>]*><span[^>]*>Example</);
});

test("what the caps left out is counted", () => {
  const omitted = { agents: 3, servers: 1, atLeast: true };
  assert.match(
    visibleText(map({ ...GRAPH, omitted }, false)),
    /Not drawn: at least 3 agents and 1 MCP server with less traffic\./,
  );
});
