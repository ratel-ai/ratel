import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { listAgentMcpCalls } from "./queries";

/**
 * The rule of `agentMcpCallsQuery` against a matcher that tries every pairing. Each case is one
 * trace and one server, with one or two clusters (apart in time, or of another tool) of up to
 * three client calls and three server calls.
 */

interface Call {
  index: number;
  side: "client" | "server";
  /** As the query reads it: its own, else its parent's. */
  caller: string | null;
  failed: boolean;
  /** The client call that is its parent. */
  parent: Call | null;
}

interface Case {
  server: string;
  clusters: Call[][];
  spans: NewOtelSpan[];
}

type Counts = Record<string, { calls: number; errors: [low: number, high: number] }>;

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const T0 = Date.parse("2026-11-10T00:00:00.000Z");
const CASES = 1_500;
const CALLERS = ["a", "b", null];

test("every random cluster counts as the matcher that tries every pairing", async () => {
  const client = await createMigratedPGlite();
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
    `);
    const db = drizzle(client, { schema }) as unknown as NonNullable<
      Parameters<typeof insertOtelSpans>[2]
    > &
      Pick<ReturnType<typeof getDb>, "execute">;
    const random = generator(278);
    const cases = Array.from({ length: CASES }, (_, index) => randomCase(index, random));
    const spans = cases.flatMap((one) => one.spans);
    for (let start = 0; start < spans.length; start += 500)
      await insertOtelSpans(PROJECT_ID, spans.slice(start, start + 500), db);
    const window = { since: new Date(T0 - 1), until: new Date(T0 + 86_400_000) };
    const rows = await listAgentMcpCalls(PROJECT_ID, window, new Map(), db);
    for (const { server, clusters } of cases) {
      const seen = rows.filter((row) => row.server === server);
      const expected = clusters.map(bruteForce).reduce(add, {});
      const shown = JSON.stringify(clusters, (key, value) =>
        key === "parent" ? (value?.index ?? null) : value,
      );
      assert.deepEqual(
        Object.fromEntries(seen.map((row) => [String(row.agent), row.calls]).sort()),
        Object.fromEntries(
          Object.entries(expected)
            .map(([caller, { calls }]) => [caller, calls])
            .sort(),
        ),
        shown,
      );
      for (const { agent, errors } of seen) {
        const [low, high] = expected[String(agent)]?.errors ?? [0, 0];
        assert.ok(
          errors >= low && errors <= high,
          `${agent}: ${errors} of ${low}-${high} ${shown}`,
        );
      }
    }
  } finally {
    await client.close();
  }
});

/** The counts of the best pairing: parent links, then the same caller, then a known one with none, then the rest. */
function bruteForce(calls: readonly Call[]): Counts {
  const linked: [Call, Call][] = [];
  for (const client of calls.filter(({ side }) => side === "client")) {
    const child = calls.find(
      ({ parent, caller }) => parent === client && (!client.caller || client.caller === caller),
    );
    if (child) linked.push([client, child]);
  }
  const open = calls.filter((call) => !linked.some((pair) => pair.includes(call)));
  const clients = open.filter(({ side }) => side === "client");
  const servers = open.filter(({ side }) => side === "server");
  const level = (client: Call, server: Call) => {
    if (client.caller && server.caller && client.caller !== server.caller) return null;
    if (server.caller === null) return 2;
    return client.caller === server.caller ? 0 : 1;
  };
  let best = [-1];
  let results: Map<string, { calls: number; errors: number }>[] = [];
  const pairs: [Call, Call][] = [];
  const visit = (at: number) => {
    const server = servers[at];
    if (server) {
      visit(at + 1);
      for (const client of clients) {
        if (pairs.some(([taken]) => taken === client) || level(client, server) === null) continue;
        pairs.push([client, server]);
        visit(at + 1);
        pairs.pop();
      }
      return;
    }
    const score = [0, 0, 0];
    for (const [client, other] of pairs) score[level(client, other) ?? 2] += 1;
    const order = compare(score, best);
    if (order < 0) return;
    if (order > 0) {
      best = score;
      results = [];
    }
    const counted = new Map<string, { calls: number; errors: number }>();
    const count = (caller: string | null, failed: boolean) => {
      const row = counted.get(String(caller)) ?? { calls: 0, errors: 0 };
      counted.set(String(caller), {
        calls: row.calls + 1,
        errors: row.errors + (failed ? 1 : 0),
      });
    };
    for (const [client, other] of pairs) {
      // A pair is the client's record, but the server's when only it knows the caller.
      const ofServer = level(client, other) === 1;
      count(client.caller ?? other.caller, ofServer ? other.failed : client.failed);
    }
    for (const [client, other] of linked) count(client.caller ?? other.caller, client.failed);
    for (const call of open)
      if (!pairs.some((pair) => pair.includes(call))) count(call.caller, call.failed);
    results.push(counted);
  };
  visit(0);
  const out: Counts = {};
  for (const counted of results)
    for (const [caller, { calls: total, errors }] of counted) {
      const [low, high] = out[caller]?.errors ?? [errors, errors];
      assert.ok(!out[caller] || out[caller].calls === total, "the rule gives one count");
      out[caller] = { calls: total, errors: [Math.min(low, errors), Math.max(high, errors)] };
    }
  return out;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let at = 0; at < a.length; at += 1) {
    const difference = (a[at] ?? 0) - (b[at] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

function add(left: Counts, right: Counts): Counts {
  const out = { ...left };
  for (const [caller, { calls, errors }] of Object.entries(right)) {
    const row = out[caller] ?? { calls: 0, errors: [0, 0] };
    out[caller] = {
      calls: row.calls + calls,
      errors: [row.errors[0] + errors[0], row.errors[1] + errors[1]],
    };
  }
  return out;
}

// — Cases ——————————————————————————————————————————————————————————————————

function randomCase(index: number, random: (below: number) => number): Case {
  const server = `server-${index}`;
  const apart = random(2) === 0;
  const clusters = Array.from({ length: 1 + random(2) }, (_, cluster) => {
    const clients = Array.from({ length: random(4) }, (_, at) => ({
      ...someCall(cluster * 10 + at, random),
      side: "client" as const,
    }));
    const servers = Array.from({ length: random(4) }, (_, at): Call => {
      const call = someCall(cluster * 10 + 5 + at, random);
      const parent = random(3) === 0 ? (clients[random(clients.length || 1)] ?? null) : null;
      return { ...call, side: "server", parent, caller: call.caller ?? parent?.caller ?? null };
    });
    return [...clients, ...servers];
  });
  const trace = (index + 1).toString(16).padStart(32, "0");
  const id = (call: Call) => (index * 100 + call.index + 1).toString(16).padStart(16, "0");
  const spans = clusters.flatMap((calls, cluster) =>
    calls.map((call): NewOtelSpan => {
      const at = T0 + index * 1_000 + call.index + (apart ? cluster * 500 : 0);
      const tool = apart ? "search" : `search-${cluster}`;
      const ended = new Date(at + 100);
      return {
        ...BLANK,
        id: `00000000-0000-4000-8000-${id(call).slice(4)}`,
        projectId: PROJECT_ID,
        receivedAt: ended,
        traceId: trace,
        spanId: id(call),
        parentSpanId: call.parent ? id(call.parent) : null,
        name: call.side === "client" ? `execute_tool ${tool}` : `tools/call ${tool}`,
        startedAt: new Date(at),
        endedAt: ended,
        statusCode: call.failed ? 2 : 1,
        mcpServer: server,
        mcpRole: call.side === "client" ? "consumed" : "provided",
        ...(call.caller ? { agentKey: call.caller, agentSource: "sdk" as const } : {}),
      };
    }),
  );
  return { server, clusters, spans };
}

function someCall(index: number, random: (below: number) => number): Call {
  const caller = CALLERS[random(CALLERS.length)] ?? null;
  return { index, side: "client", caller, failed: random(3) === 0, parent: null };
}

/** The same numbers on every run. */
function generator(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((state / 2 ** 32) * below);
  };
}

const BLANK = {
  kind: 1,
  spanClass: "tool",
  durationMs: 100,
  serviceName: null,
  scopeName: "fixture",
  operationName: null,
  providerName: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  cachedTokens: null,
  reasoningTokens: null,
  costUsd: null,
  searchOrigin: null,
  searchTarget: null,
  searchQuery: null,
  searchTopK: null,
  searchHitCount: null,
  experimentName: null,
  experimentArm: null,
  experimentRole: null,
  experimentAttrs: {},
  attributes: {},
  attrsTruncated: false,
} as const;
