import assert from "node:assert/strict";
import { test } from "node:test";
import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import {
  identityFingerprint,
  type JudgeCase,
  type JudgeEngine,
} from "@/lib/readings/decisions/judge";
import {
  entryIdentities,
  judgeTargets,
  labelPrint,
  readPrint,
  sampleAdaptively,
} from "@/lib/synthesis/match-quality/judge";
import type { GroundTruthLabel } from "@/lib/synthesis/match-quality/labels";
import type { EvalItem } from "@/lib/synthesis/match-quality/types";

const OURS = "ratel";
const BASE = "legacy";

function item(
  id: string,
  opts: { query?: string; ours?: string[]; base?: string[] } = {},
): EvalItem {
  return {
    selectionId: id,
    occurredAt: new Date("2026-09-01T00:00:00Z"),
    query: opts.query ?? `query ${id}`,
    targetEntryId: "tool_a",
    targetKind: "tool",
    targetSource: "reference",
    arms: [
      { arm: OURS, role: "serving", resultIds: opts.ours ?? ["tool_a"], resultScores: null },
      { arm: BASE, role: "shadow", resultIds: opts.base ?? ["tool_a"], resultScores: null },
    ],
  };
}

function entry(entryId: string, description = `does ${entryId} things`): CorpusEntry {
  return {
    entryId,
    name: entryId,
    description,
    searchable: description,
    source: "runtime",
    matchesAgentDescription: false,
    tags: [],
  };
}

const CORPUS = ["tool_a", "tool_b", "tool_c"].map((id) => entry(id));

function judged(
  query: string,
  entryId: string,
  print: string | null,
  runnerUp: string | null = null,
): GroundTruthLabel {
  return {
    queryKey: query,
    query,
    entryId,
    source: entryId === "" ? "unclear" : "judge",
    confident: true,
    model: "jev",
    selectionId: null,
    occurrences: 1,
    observedAt: new Date("2026-09-01T00:00:00Z"),
    runnerUp,
    catalogFingerprint: print,
  };
}

/** An engine that answers `tool_a` for every case, recording each batch it was asked. */
function recordingEngine(
  answer: (row: JudgeCase) => string = () => "tool_a",
): JudgeEngine & { batches: number[] } {
  const batches: number[] = [];
  return {
    model: "test-engine",
    batches,
    async judge(cases) {
      batches.push(cases.length);
      return cases.map((row) => ({ id: row.id, entryId: answer(row), confident: true }));
    },
  };
}

test("a verdict printed per tool stays fresh when other tools change, and goes stale when its own does", () => {
  const ids = entryIdentities(CORPUS);
  const catalog = identityFingerprint(CORPUS);
  const print = labelPrint(ids, catalog, "tool_a", "tool_b");
  assert.ok(print.startsWith("e:"));
  assert.deepEqual(
    readPrint({ entryId: "tool_a", runnerUp: "tool_b", catalogFingerprint: print }, ids, catalog),
    { fresh: true, moved: false },
  );

  // A new tool arrives: the catalog moved, but tool_a and tool_b did not.
  const grown = [...CORPUS, entry("tool_d")];
  assert.deepEqual(
    readPrint(
      { entryId: "tool_a", runnerUp: "tool_b", catalogFingerprint: print },
      entryIdentities(grown),
      identityFingerprint(grown),
    ),
    { fresh: true, moved: true },
  );
  // tool_a's own description changed: stale.
  const edited = [entry("tool_a", "now does other things"), ...CORPUS.slice(1)];
  assert.deepEqual(
    readPrint(
      { entryId: "tool_a", runnerUp: "tool_b", catalogFingerprint: print },
      entryIdentities(edited),
      identityFingerprint(edited),
    ),
    { fresh: false, moved: false },
  );
  // An abstention and every older verdict keep the catalog-wide rule.
  assert.equal(labelPrint(ids, catalog, "", null), catalog);
  assert.deepEqual(readPrint({ entryId: "tool_a", catalogFingerprint: catalog }, ids, catalog), {
    fresh: true,
    moved: false,
  });
  assert.deepEqual(readPrint({ entryId: "tool_a", catalogFingerprint: "old" }, ids, catalog), {
    fresh: false,
    moved: false,
  });
});

test("the adaptive sample asks what the margin needs", () => {
  const rows = Array.from({ length: 2_000 }, (_, index) =>
    item(`s${index}`, { query: `q${index}` }),
  );
  const first = sampleAdaptively(rows, OURS, BASE, {
    fingerprint: "fp",
    identities: entryIdentities(CORPUS),
  });
  // Nothing known: about 320 for plus or minus five points over 2,000 requests.
  assert.ok(first.cases.length > 250 && first.cases.length < 400, `got ${first.cases.length}`);
  assert.equal(first.tally.control.population, 2_000, "every search agreed, so all are control");

  // 300 already answered, nearly all our first result: the margin is met, only the drift sample is asked.
  const ids = entryIdentities(CORPUS);
  const key = new Map(
    Array.from(
      { length: 300 },
      (_, index) =>
        [`q${index}`, judged(`q${index}`, "tool_a", labelPrint(ids, "fp", "tool_a"))] as const,
    ),
  );
  const settled = sampleAdaptively(rows, OURS, BASE, {
    key,
    fingerprint: "fp",
    identities: ids,
    drift: 10,
  });
  assert.equal(settled.cases.length, 10);
  assert.ok(
    settled.cases.every((row) => Number(row.id.slice(1)) >= 300),
    "drift reads never-read requests",
  );
  assert.equal(
    sampleAdaptively(rows, OURS, BASE, { key, fingerprint: "fp", identities: ids, drift: 0 }).cases
      .length,
    0,
  );
});

test("the adaptive judge asks in batches and stops once the margin is met", async () => {
  const rows = Array.from({ length: 3_000 }, (_, index) =>
    item(`s${index}`, { query: `q${index}` }),
  );
  const engine = recordingEngine();
  const result = await judgeTargets(rows, CORPUS, OURS, BASE, engine, {
    fingerprint: identityFingerprint(CORPUS),
    adaptive: { roundSize: 100 },
  });
  assert.ok(result);
  const adaptive = result.census.adaptive;
  assert.ok(adaptive);
  // Every answer is our first result, so the share settles fast: far fewer than 500 asked.
  const total = engine.batches.reduce((a, b) => a + b, 0);
  assert.ok(
    engine.batches.every((size) => size <= 100 + 20),
    "a round is a batch (plus the drift sample)",
  );
  assert.ok(total < 300, `asked ${total}`);
  assert.equal(adaptive.stopped, "margin_met");
  assert.equal(adaptive.stillNeeded, 0);
  assert.ok((adaptive.margin ?? 1) <= 0.05);
  assert.ok((adaptive.share ?? 0) > 0.95);
  assert.equal(result.labels.length, total);
  assert.ok(
    result.labels.every((label) => label.catalogFingerprint?.startsWith("e:")),
    "new verdicts are printed per tool",
  );
});

test("an uncertain share asks more rounds than a clear one", async () => {
  const rows = Array.from({ length: 3_000 }, (_, index) =>
    item(`s${index}`, { query: `q${index}` }),
  );
  const clear = recordingEngine();
  await judgeTargets(rows, CORPUS, OURS, BASE, clear, {
    fingerprint: "fp",
    adaptive: { roundSize: 100 },
  });
  // Most answers name another tool: our first result is right about 43% of the time (a pattern no even spread aliases).
  const mixed = recordingEngine((row) => (Number(row.id.slice(1)) % 7 < 3 ? "tool_a" : "tool_b"));
  await judgeTargets(rows, CORPUS, OURS, BASE, mixed, {
    fingerprint: "fp",
    adaptive: { roundSize: 100 },
  });
  const sum = (batches: number[]) => batches.reduce((a, b) => a + b, 0);
  assert.ok(
    sum(mixed.batches) > sum(clear.batches) + 100,
    `mixed ${sum(mixed.batches)} vs clear ${sum(clear.batches)}`,
  );
});

test("the adaptive judge respects the engine's capacity and a stop", async () => {
  const rows = Array.from({ length: 3_000 }, (_, index) =>
    item(`s${index}`, { query: `q${index}` }),
  );
  const capped = { ...recordingEngine(), capacity: () => 150 };
  const result = await judgeTargets(rows, CORPUS, OURS, BASE, capped, {
    fingerprint: "fp",
    adaptive: { roundSize: 100 },
  });
  assert.ok(result?.census.adaptive);
  assert.ok(capped.batches.reduce((a, b) => a + b, 0) <= 150);

  const stopping: JudgeEngine = {
    model: "stops",
    async judge(cases) {
      return cases.slice(0, 5).map((row) => ({ id: row.id, entryId: "tool_a", confident: true }));
    },
  };
  const stopped = await judgeTargets(rows, CORPUS, OURS, BASE, stopping, { fingerprint: "fp" });
  assert.equal(stopped?.census.adaptive?.stopped, "engine_stopped");
  assert.equal(stopped?.census.adaptive?.rounds, 1);
});

test("the audit re-asks carried verdicts after a catalog change, and a failed audit re-reads them all", async () => {
  const ids = entryIdentities(CORPUS);
  const oldCatalog = identityFingerprint(CORPUS);
  const grown = [...CORPUS, entry("tool_d")];
  const rows = Array.from({ length: 200 }, (_, index) => item(`s${index}`, { query: `q${index}` }));
  const key = new Map(
    Array.from(
      { length: 200 },
      (_, index) =>
        [
          `q${index}`,
          judged(`q${index}`, "tool_a", labelPrint(ids, oldCatalog, "tool_a")),
        ] as const,
    ),
  );

  // The new tool changes nothing: the audit agrees, the rest stay carried.
  const agreeing = recordingEngine();
  const kept = await judgeTargets(rows, grown, OURS, BASE, agreeing, {
    key,
    fingerprint: identityFingerprint(grown),
  });
  assert.equal(kept?.census.adaptive?.audit, "trust");
  assert.equal(kept?.census.adaptive?.audited, 20);
  assert.equal(
    agreeing.batches.reduce((a, b) => a + b, 0),
    20,
    "only the audit sample was asked",
  );

  // The new tool wins most of them: the audit fails, and every carried verdict is read again.
  const moving = recordingEngine(() => "tool_d");
  const reread = await judgeTargets(rows, grown, OURS, BASE, moving, {
    key,
    fingerprint: identityFingerprint(grown),
  });
  assert.equal(reread?.census.adaptive?.audit, "distrust");
  assert.ok(moving.batches.length > 1, "later rounds re-read the carried verdicts");
  assert.ok(moving.batches.reduce((a, b) => a + b, 0) > 20);
});

test("a later round that fails keeps what the earlier rounds bought; a first round that fails fails as before", async () => {
  const rows = Array.from({ length: 3_000 }, (_, index) =>
    item(`s${index}`, { query: `q${index}` }),
  );
  let calls = 0;
  const flaky: JudgeEngine = {
    model: "flaky",
    async judge(cases) {
      calls += 1;
      if (calls === 2) throw new Error("rate limited");
      return cases.map((row) => ({
        id: row.id,
        entryId: Number(row.id.slice(1)) % 7 < 3 ? "tool_a" : "tool_b",
        confident: true,
      }));
    },
  };
  const kept = await judgeTargets(rows, CORPUS, OURS, BASE, flaky, {
    fingerprint: "fp",
    adaptive: { roundSize: 100 },
  });
  assert.equal(kept?.census.adaptive?.stopped, "engine_failed");
  assert.equal(kept?.census.adaptive?.rounds, 1);
  assert.ok((kept?.labels.length ?? 0) >= 100, "round one's answers are returned");

  const broken: JudgeEngine = {
    model: "broken",
    judge: async () => Promise.reject(new Error("no key")),
  };
  await assert.rejects(
    judgeTargets(rows, CORPUS, OURS, BASE, broken, { fingerprint: "fp" }),
    /no key/,
  );
});

test("a round is not started when the slowest round so far would overrun the deadline", async () => {
  const rows = Array.from({ length: 3_000 }, (_, index) =>
    item(`s${index}`, { query: `q${index}` }),
  );
  let clock = 0;
  const slow: JudgeEngine = {
    model: "slow",
    async judge(cases) {
      clock += 2 * 60_000;
      return cases.map((row) => ({
        id: row.id,
        entryId: Number(row.id.slice(1)) % 7 < 3 ? "tool_a" : "tool_b",
        confident: true,
      }));
    },
  };
  const result = await judgeTargets(rows, CORPUS, OURS, BASE, slow, {
    fingerprint: "fp",
    adaptive: { roundSize: 100, deadlineMs: 5 * 60_000, now: () => clock },
  });
  assert.equal(result?.census.adaptive?.stopped, "deadline");
  assert.equal(
    result?.census.adaptive?.rounds,
    2,
    "two 2-minute rounds fit in 5 minutes; a third would not",
  );
});

test("each round spreads over the whole window, not the newest slice", async () => {
  const rows = Array.from({ length: 3_000 }, (_, index) =>
    item(`s${index}`, { query: `q${index}` }),
  );
  const first = sampleAdaptively(rows, OURS, BASE, {
    fingerprint: "fp",
    identities: entryIdentities(CORPUS),
    maxCases: 100,
  });
  const positions = first.cases.map((row) => Number(row.id.slice(1)));
  assert.equal(positions.length, 100);
  assert.ok(Math.max(...positions) > 2_500, "reaches the oldest part of the window");
});

test("the audit's answers refresh the key but are kept out of the census", async () => {
  const ids = entryIdentities(CORPUS);
  const grown = [...CORPUS, entry("tool_d")];
  const rows = Array.from({ length: 200 }, (_, index) => item(`s${index}`, { query: `q${index}` }));
  const key = new Map(
    Array.from(
      { length: 200 },
      (_, index) =>
        [
          `q${index}`,
          judged(`q${index}`, "tool_a", labelPrint(ids, identityFingerprint(CORPUS), "tool_a")),
        ] as const,
    ),
  );
  const result = await judgeTargets(rows, grown, OURS, BASE, recordingEngine(), {
    key,
    fingerprint: identityFingerprint(grown),
  });
  assert.equal(result?.census.adaptive?.audited, 20);
  assert.equal(
    result?.census.sampledControl,
    0,
    "only audit cases were asked, and none is counted as sampled",
  );
  assert.equal(result?.labels.length, 20, "but their answers are stored, with the new catalog");
});
