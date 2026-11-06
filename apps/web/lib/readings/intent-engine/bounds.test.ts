import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundCluster,
  capCounts,
  MAX_EDGE_KEYS,
  MAX_ID_CHARS,
  MAX_SOURCES,
} from "@/lib/readings/intent-engine/bounds";
import { type EngineEventRow, foldAsks } from "@/lib/readings/intent-engine/engine";
import type { EngineCluster, SourceSlice } from "@/lib/readings/intent-types/engine-types";

const many = (n: number, prefix: string) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, i + 1]));

test("a count map keeps its biggest keys, ties by key, and is untouched when it fits", () => {
  assert.deepEqual(capCounts({ a: 1, b: 3, c: 3, d: 2 }, 2), { b: 3, c: 3 });
  const small = { a: 1 };
  assert.deepEqual(capCounts(small), small);
});

test("a cluster is written within bounds: maps and sources", () => {
  const slice = (support: number): SourceSlice => ({
    graphId: "intent_1",
    support,
    members: [],
    tools: many(300, "t"),
    skills: {},
  });
  const cluster = {
    uuid: "u",
    id: "intent_0",
    label: "x",
    terms: [],
    members: [],
    servedMembers: [],
    support: 1,
    asks: 1,
    first_ts: 0,
    tools: many(500, "t"),
    skills: many(5, "s"),
    surfaced_tools: many(250, "x"),
    usage: many(1_000, "tool:t"),
    sources: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`src${i}`, slice(i)])),
    queryIntentId: null,
  } as EngineCluster;
  const bounded = boundCluster(cluster);
  assert.equal(Object.keys(bounded.tools).length, MAX_EDGE_KEYS);
  assert.equal(bounded.tools.t499, 500, "the biggest are kept");
  assert.equal(Object.keys(bounded.skills).length, 5);
  assert.equal(Object.keys(bounded.surfaced_tools!).length, MAX_EDGE_KEYS);
  assert.equal(Object.keys(bounded.usage).length, MAX_EDGE_KEYS);
  assert.deepEqual(
    Object.keys(bounded.sources).sort(),
    Array.from({ length: MAX_SOURCES }, (_, i) => `src${39 - i}`).sort(),
  );
  assert.equal(Object.keys(bounded.sources.src39!.tools).length, MAX_EDGE_KEYS);
  assert.equal(Object.keys(cluster.tools).length, 500, "the input is not changed");
});

test("an invoke with an id longer than any real one is not credited", () => {
  const at = new Date("2026-10-20T00:00:00Z");
  const rows: EngineEventRow[] = [
    {
      id: "e1",
      type: "search",
      lane: "runtime",
      sessionId: "s",
      turnId: "t",
      sourceId: null,
      query: "list open invoices",
      toolId: null,
      skillId: null,
      receivedAt: at,
    },
    {
      id: "e2",
      type: "invoke_start",
      lane: "runtime",
      sessionId: "s",
      turnId: "t",
      sourceId: null,
      query: null,
      toolId: "x".repeat(MAX_ID_CHARS + 1),
      skillId: null,
      receivedAt: at,
    },
    {
      id: "e3",
      type: "invoke_start",
      lane: "runtime",
      sessionId: "s",
      turnId: "t",
      sourceId: null,
      query: null,
      toolId: "list_invoices",
      skillId: null,
      receivedAt: at,
    },
  ];
  const out = foldAsks({
    state: { clusters: [], nextGraphN: 0 },
    rows,
    hits: new Map(),
    now: at.getTime(),
  });
  assert.deepEqual(out.state.clusters[0]!.tools, { list_invoices: 1 });
});
