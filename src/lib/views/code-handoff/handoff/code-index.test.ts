import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeGitHub } from "../fake-github";
import type { GitHubPort } from "../ports";
import type { NewCodePointer } from "../store";
import {
  type CodeIndexDeps,
  type CodeIndexPayload,
  type EnqueueCodeIndexDeps,
  enqueueCodeIndex,
  firstLineOf,
  type IndexSymbol,
  orderSymbols,
  promptSlice,
  runCodeIndex,
} from "./code-index";

const INSTALLATION = 7;
const LINK = { id: "link-1", installationId: INSTALLATION, owner: "acme", name: "agent" };
/** File text that must never reach a row or a log line. */
const SECRET_LINE = "const apiKey = load('very-secret-file-content');";

const FILES: Record<string, string> = {
  "src/tools/orders.ts": [
    "import { z } from 'zod';",
    SECRET_LINE,
    'export const tool = { name: "lookup_order" };',
  ].join("\n"),
  "src/agent.ts": ["// the agent", 'const model = "claude-sonnet-5-5";', SECRET_LINE].join("\n"),
  "README.md": "Nothing here.",
};

function github(files: Record<string, string> = FILES): GitHubPort & { searches: string[] } {
  const fake = createFakeGitHub();
  fake.addRepo(INSTALLATION, { id: 1, owner: "acme", name: "agent", defaultBranch: "main" }, files);
  const searches: string[] = [];
  return {
    ...fake,
    searches,
    async searchCode(installationId, repo, query) {
      searches.push(query);
      return fake.searchCode(installationId, repo, query);
    },
  };
}

interface Harness {
  deps: CodeIndexDeps;
  rows: Map<string, NewCodePointer[]>;
  requeued: CodeIndexPayload[];
  logs: unknown[][];
}

function harness(symbols: IndexSymbol[], over: Partial<CodeIndexDeps> = {}): Harness {
  const rows = new Map<string, NewCodePointer[]>();
  const requeued: CodeIndexPayload[] = [];
  const logs: unknown[][] = [];
  const deps: CodeIndexDeps = {
    github: github(),
    getRepoLink: async () => LINK,
    listSymbols: async () => symbols,
    replaceSymbolPointers: async (_linkId, symbol, pointers) => {
      rows.set(`${symbol.kind}:${symbol.symbol}`, pointers);
    },
    prunePointers: async (_linkId, keep) => {
      const kept = new Set(keep.map((symbol) => `${symbol.kind}:${symbol.symbol}`));
      for (const key of [...rows.keys()]) if (!kept.has(key)) rows.delete(key);
    },
    requeue: async (_projectId, payload) => {
      requeued.push(payload);
    },
    log: (...args) => logs.push(args),
    ...over,
  };
  return { deps, rows, requeued, logs };
}

const TOOL: IndexSymbol = { kind: "tool", symbol: "lookup_order" };
const MODEL: IndexSymbol = { kind: "model", symbol: "claude-sonnet-5-5" };

test("a run stores the path and line of a tool name and a model id", async () => {
  const h = harness([TOOL, MODEL]);
  const result = await runCodeIndex("p1", null, h.deps);
  assert.equal(result.outcome, "complete");
  assert.deepEqual(h.rows.get("tool:lookup_order"), [
    { kind: "tool", symbol: "lookup_order", path: "src/tools/orders.ts", line: 3 },
  ]);
  assert.deepEqual(h.rows.get("model:claude-sonnet-5-5"), [
    { kind: "model", symbol: "claude-sonnet-5-5", path: "src/agent.ts", line: 2 },
  ]);
  assert.deepEqual(h.requeued, []);
});

test("rows and log lines hold no file content", async () => {
  const h = harness([TOOL, MODEL, { kind: "prompt", symbol: "You are a travel agent" }]);
  await runCodeIndex("p1", null, h.deps);
  for (const pointers of h.rows.values()) {
    for (const pointer of pointers) {
      assert.deepEqual(Object.keys(pointer).sort(), ["kind", "line", "path", "symbol"]);
    }
  }
  const logged = JSON.stringify(h.logs);
  assert.ok(h.logs.length > 0, "the run logs");
  assert.ok(!logged.includes("very-secret-file-content"), "no file text in logs");
  assert.ok(!logged.includes("You are a travel agent"), "no prompt text in logs");
  assert.ok(!JSON.stringify([...h.rows.values()]).includes("very-secret-file-content"));
});

test("a run stops at its budget and the next run continues with the rest", async () => {
  const symbols = Array.from(
    { length: 11 },
    (_, index): IndexSymbol => ({ kind: "tool", symbol: `tool_${index}` }),
  );
  const h = harness(symbols, { budget: 8 });
  const first = await runCodeIndex("p1", null, h.deps);
  assert.equal(first.outcome, "partial");
  assert.equal(first.indexed, 8);
  assert.equal(first.remaining, 3);
  assert.deepEqual(h.requeued, [{ linkId: LINK.id, offset: 8 }]);
  const searchesAfterFirst = (h.deps.github as ReturnType<typeof github>).searches.length;
  assert.equal(searchesAfterFirst, 8, "one search per symbol");

  const second = await runCodeIndex("p1", h.requeued[0], h.deps);
  assert.equal(second.outcome, "complete");
  assert.equal(second.indexed, 3);
  assert.equal(h.requeued.length, 1, "nothing left to queue");
  assert.deepEqual((h.deps.github as ReturnType<typeof github>).searches.slice(8), [
    '"tool_8"',
    '"tool_9"',
    '"tool_10"',
  ]);
  assert.equal(h.rows.size, 11, "every symbol was indexed (an empty list each)");
});

test("a rate-limit answer stores what was found and queues the rest", async () => {
  const base = github();
  let calls = 0;
  const limited: GitHubPort = {
    ...base,
    async searchCode(installationId, repo, query) {
      calls += 1;
      if (calls === 2) throw new Error("github GET /search/code failed with status 403");
      return base.searchCode(installationId, repo, query);
    },
  };
  const h = harness([TOOL, MODEL, { kind: "tool", symbol: "other" }], { github: limited });
  const result = await runCodeIndex("p1", null, h.deps);
  assert.equal(result.outcome, "rate_limited");
  assert.ok(h.rows.has("tool:lookup_order"), "the first symbol is kept");
  assert.ok(!h.rows.has("model:claude-sonnet-5-5"), "the limited one is not");
  assert.deepEqual(h.requeued, [{ linkId: LINK.id, offset: 1 }]);
});

test("a 429 while reading a file is a rate limit too", async () => {
  const base = github();
  const limited: GitHubPort = {
    ...base,
    async readFile() {
      throw new Error("github GET /repos/acme/agent/contents/src/agent.ts failed with status 429");
    },
  };
  const h = harness([TOOL], { github: limited });
  assert.equal((await runCodeIndex("p1", null, h.deps)).outcome, "rate_limited");
  assert.deepEqual(h.requeued, [{ linkId: LINK.id, offset: 0 }]);
});

test("another GitHub failure fails the job", async () => {
  const base = github();
  const broken: GitHubPort = {
    ...base,
    searchCode: async () => {
      throw new Error("github GET /search/code failed with status 500");
    },
  };
  await assert.rejects(
    runCodeIndex("p1", null, harness([TOOL], { github: broken }).deps),
    /status 500/,
  );
});

test("a re-index replaces the pointers of a symbol and drops symbols that are gone", async () => {
  const h = harness([TOOL, MODEL]);
  await runCodeIndex("p1", null, h.deps);
  await runCodeIndex("p1", null, h.deps);
  assert.equal(h.rows.get("tool:lookup_order")?.length, 1, "not duplicated");
  const fewer = harness([TOOL]);
  for (const [key, value] of h.rows) fewer.rows.set(key, value);
  await runCodeIndex("p1", null, fewer.deps);
  assert.deepEqual([...fewer.rows.keys()], ["tool:lookup_order"]);
});

test("a run for a project without a link does nothing", async () => {
  const h = harness([TOOL], { getRepoLink: async () => null });
  assert.equal((await runCodeIndex("p1", null, h.deps)).outcome, "no_link");
  assert.equal(h.rows.size, 0);
});

test("a queued run for an older link starts over", async () => {
  const h = harness([TOOL, MODEL]);
  const result = await runCodeIndex("p1", { linkId: "old-link", offset: 1 }, h.deps);
  assert.equal(result.indexed, 2);
});

test("firstLineOf finds the first matching line, 1-based", () => {
  assert.equal(firstLineOf("a\nb lookup_order\nlookup_order", "lookup_order"), 2);
  assert.equal(firstLineOf("a\r\nb", "b"), 2);
  assert.equal(firstLineOf("a", "z"), null);
});

test("promptSlice takes a short distinctive line without quotes", () => {
  assert.equal(
    promptSlice(
      'Hi.\nYou are "Ava", the travel agent for Meridian Travel. Be brief and kind to every traveller.',
    ),
    "You are Ava, the travel agent for Meridian Travel. Be brief",
  );
  assert.equal(promptSlice("short\nlines\nonly"), null);
});

test("orderSymbols puts the tools of open fixes first, then tools, models and prompts, once each", () => {
  const ordered = orderSymbols({
    fixTools: ["b_tool"],
    tools: ["a_tool", "b_tool"],
    models: ["m1"],
    prompts: ["You are a travel agent for Meridian"],
  });
  assert.deepEqual(ordered, [
    { kind: "tool", symbol: "b_tool" },
    { kind: "tool", symbol: "a_tool" },
    { kind: "model", symbol: "m1" },
    { kind: "prompt", symbol: "You are a travel agent for Meridian" },
  ]);
});

function enqueueDeps(
  over: Partial<EnqueueCodeIndexDeps> = {},
): EnqueueCodeIndexDeps & { queued: string[] } {
  const queued: string[] = [];
  return {
    queued,
    hasLink: async () => true,
    inFlight: async () => false,
    ranWithin: async () => false,
    enqueue: async (projectId) => {
      queued.push(projectId);
    },
    ...over,
  };
}

test("enqueue queues one run, and skips when one is in flight", async () => {
  const deps = enqueueDeps();
  assert.equal(await enqueueCodeIndex("p1", {}, deps), "queued");
  assert.deepEqual(deps.queued, ["p1"]);
  const busy = enqueueDeps({ inFlight: async () => true });
  assert.equal(await enqueueCodeIndex("p1", {}, busy), "in_flight");
  assert.deepEqual(busy.queued, []);
});

test("enqueue at handoff skips a fresh index and a project without a link", async () => {
  const fresh = enqueueDeps({ ranWithin: async () => true });
  assert.equal(await enqueueCodeIndex("p1", { staleAfterMs: 86_400_000 }, fresh), "fresh");
  assert.deepEqual(fresh.queued, []);
  const unlinked = enqueueDeps({ hasLink: async () => false });
  assert.equal(await enqueueCodeIndex("p1", {}, unlinked), "no_link");
});
