import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixes } from "@/lib/views/fixes/build";
import { fixStats } from "@/lib/views/fixes/select";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";
import type { Fix, FixGain } from "@/lib/views/fixes/types";

const base = buildFixes(fixesInput()).open.find((fix) => fix.id === "craft:c-merge")!;
const task = base.subject.tasks[0]!;
const otherTask = { ...task, id: "other", label: "Another task" };

function fix(id: string, tools: string[], gain: FixGain | null, tasks = [task]): Fix {
  return {
    ...base,
    id,
    gain,
    subject: { ...base.subject, tools: tools.map((id) => ({ id, label: id, href: "/" })), tasks },
  };
}

test("savings count each overlap group once per metric, in total and in each task", () => {
  const open = [
    fix("a", ["a"], { windowDays: 1, roundTrips: 10, calls: 10, tokens: 100, usd: 1, ms: 300 }, [
      task,
      otherTask,
    ]),
    fix("b", ["a", "b"], {
      windowDays: 1,
      roundTrips: 20,
      calls: 20,
      tokens: 200,
      usd: 0.5,
      ms: 100,
    }),
    fix("c", ["b"], { windowDays: 1, roundTrips: 5, calls: 5, tokens: 50, usd: 2, ms: 200 }),
    fix("d", ["d"], { windowDays: 1, roundTrips: 3, calls: 3, tokens: 30, usd: null, ms: 50 }),
  ];
  const savings = fixStats(open).savings;
  assert.deepEqual(savings.total.absolute, { tokens: 230, usd: 2, ms: 350 });
  assert.deepEqual(
    savings.tasks.map((entry) => [entry.task.id, entry.absolute]),
    [
      [task.id, { tokens: 230, usd: 2, ms: 350 }],
      [otherTask.id, { tokens: 100, usd: 1, ms: 300 }],
    ],
  );
  assert.equal(fixStats(open).roundTripsSaved, 23);
});

test("task savings use their own usage and omit shares for unknown or zero usage", () => {
  const open = [
    fix("a", ["a"], { windowDays: 1, roundTrips: 10, calls: 10, tokens: 100, usd: 1, ms: null }, [
      task,
      otherTask,
    ]),
    fix("unknown", ["unknown"], null, [{ ...task, id: "unknown" }]),
  ];
  const savings = fixStats(
    open,
    new Map([
      [task.id, { windowDays: 1, tokens: 1_000, usd: 4, ms: 5_000 }],
      [otherTask.id, { tokens: 0, usd: null, ms: null }],
    ]),
  ).savings;
  assert.deepEqual(
    savings.tasks.map((entry) => [entry.task.id, entry.relative]),
    [
      [task.id, { tokens: 0.1, usd: 0.25, ms: null }],
      [otherTask.id, { tokens: null, usd: null, ms: null }],
      ["unknown", { tokens: null, usd: null, ms: null }],
    ],
  );
  assert.deepEqual(savings.tasks[2]!.absolute, { tokens: null, usd: null, ms: null });
  assert.deepEqual(fixStats([]).savings.total.absolute, { tokens: null, usd: null, ms: null });
});

test("a measured zero remains zero in absolute savings and in a known usage share", () => {
  const open = [
    fix("zero", [], { windowDays: 1, roundTrips: 0, calls: 0, tokens: 0, usd: 0, ms: 0 }),
  ];
  const savings = fixStats(
    open,
    new Map([[task.id, { windowDays: 1, tokens: 100, usd: 1, ms: 1_000 }]]),
  ).savings;
  assert.deepEqual(savings.total, {
    windowDays: 1,
    absolute: { tokens: 0, usd: 0, ms: 0 },
    relative: { tokens: 0, usd: 0, ms: 0 },
  });
  assert.deepEqual(savings.tasks[0]!.relative, { tokens: 0, usd: 0, ms: 0 });
});

test("savings normalize each fix and task usage to a daily rate before overlap and addition", () => {
  const open = [
    fix("week", ["shared"], {
      windowDays: 7,
      roundTrips: 0,
      calls: 0,
      tokens: 700,
      usd: 7,
      ms: 7_000,
    }),
    fix("month", ["shared"], {
      windowDays: 30,
      roundTrips: 0,
      calls: 0,
      tokens: 1_500,
      usd: 60,
      ms: 15_000,
    }),
    fix("other", ["separate"], {
      windowDays: 10,
      roundTrips: 0,
      calls: 0,
      tokens: 200,
      usd: null,
      ms: null,
    }),
  ];
  const savings = fixStats(
    open,
    new Map([[task.id, { windowDays: 20, tokens: 4_800, usd: 80, ms: 40_000 }]]),
  ).savings;
  assert.equal(savings.total.windowDays, 1);
  assert.deepEqual(savings.total.absolute, { tokens: 120, usd: 2, ms: 1_000 });
  assert.deepEqual(savings.tasks[0]!.relative, { tokens: 0.5, usd: 0.5, ms: 0.5 });
  assert.deepEqual(savings.total.relative, { tokens: 0.5, usd: 0.5, ms: 0.5 });
});
