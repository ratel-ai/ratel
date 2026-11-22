import assert from "node:assert/strict";
import { test } from "node:test";
import type { CorpusEntry, JudgeCase, JudgeEngine } from "@/lib/readings/decisions/judge";
import { type CarriedRow, decideWithCarry, optionPrint } from "./carry";

function option(entryId: string, description = `about ${entryId}`): CorpusEntry {
  return {
    entryId,
    name: entryId,
    description,
    searchable: description,
    source: "description",
    matchesAgentDescription: false,
    tags: [],
  };
}

const cases = (n: number): JudgeCase[] =>
  Array.from({ length: n }, (_, index) => ({
    id: `ask${index}`,
    query: `ask ${index}`,
    shortlist: [],
    assumed: "",
    stratum: "control" as const,
  }));

function engine(answer: (row: JudgeCase) => string): JudgeEngine & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    model: "test",
    asked,
    async judge(rows) {
      asked.push(rows.map((row) => row.id));
      return rows.map((row) => ({ id: row.id, entryId: answer(row), confident: true }));
    },
  };
}

const OLD = [option("billing"), option("travel")];
const NEW = [...OLD, option("refunds")];

function carriedFrom(options: readonly CorpusEntry[], n: number, chosen = "billing"): CarriedRow[] {
  const target = options.find((o) => o.entryId === chosen)!;
  return cases(n).map((row) => ({
    promptHash: row.id,
    optionId: chosen,
    optionPrint: optionPrint("topic", target),
  }));
}

test("a decision whose option is still here unchanged is carried, and only the audit sample is re-asked", async () => {
  const judge = engine(() => "billing");
  const out = await decideWithCarry({
    family: "topic",
    cases: cases(100),
    options: NEW,
    exact: new Map(),
    previous: carriedFrom(OLD, 100),
    judge,
    budget: 300,
  });
  assert.equal(out.audit, "trust");
  assert.equal(out.audited, 20);
  assert.equal(judge.asked.flat().length, 20, "80 carried, 20 re-asked");
  assert.equal(out.carried.size, 80);
  assert.equal(out.choices.size, 100);
});

test("when the new option wins the audit, nothing is carried and the asks are put again within the budget", async () => {
  const judge = engine(() => "refunds");
  const out = await decideWithCarry({
    family: "topic",
    cases: cases(100),
    options: NEW,
    exact: new Map(),
    previous: carriedFrom(OLD, 100),
    judge,
    budget: 60,
  });
  assert.equal(out.audit, "distrust");
  assert.equal(out.carried.size, 0);
  assert.equal(judge.asked.flat().length, 60, "the audit plus a retry, never past the budget");
  assert.ok([...out.choices.values()].every((choice) => choice === "refunds"));
  assert.equal(out.choices.size, 60, "the rest are left undecided rather than carried");
});

test("a changed option is not carried; an exact answer for this list is free", async () => {
  const edited = [option("billing", "now about invoices"), option("travel")];
  const judge = engine(() => "travel");
  const exact = new Map([["ask0", { entryId: "billing" }]]);
  const out = await decideWithCarry({
    family: "topic",
    cases: cases(5),
    options: edited,
    exact,
    previous: carriedFrom(OLD, 5),
    judge,
    budget: 10,
  });
  assert.equal(out.carried.size, 0);
  assert.deepEqual(judge.asked, [["ask1", "ask2", "ask3", "ask4"]]);
  assert.equal(out.choices.get("ask0"), "billing");
});

test("prints differ by family and by what the engine reads", () => {
  assert.notEqual(optionPrint("topic", option("a")), optionPrint("workflow", option("a")));
  assert.notEqual(optionPrint("topic", option("a")), optionPrint("topic", option("a", "else")));
  assert.equal(optionPrint("topic", option("a")), optionPrint("topic", option("a")));
});

test("the newest stored decision for an ask wins, and the budget bounds fresh asks", async () => {
  const judge = engine(() => "travel");
  const travel = OLD[1]!;
  const previous: CarriedRow[] = [
    { promptHash: "ask0", optionId: "travel", optionPrint: optionPrint("topic", travel) },
    ...carriedFrom(OLD, 1),
  ];
  const out = await decideWithCarry({
    family: "topic",
    cases: cases(30),
    options: OLD,
    exact: new Map(),
    previous,
    judge,
    budget: 5,
    auditSample: 0,
  });
  assert.equal(out.carried.get("ask0"), "travel");
  assert.equal(judge.asked.flat().length, 5);
});

test("the caller's budget is charged for every case asked, answered or not", async () => {
  const quiet: JudgeEngine = {
    model: "quiet",
    judge: async (rows) =>
      rows.slice(0, 2).map((row) => ({ id: row.id, entryId: "billing", confident: true })),
  };
  const out = await decideWithCarry({
    family: "topic",
    cases: cases(10),
    options: OLD,
    exact: new Map(),
    previous: [],
    judge: quiet,
    budget: 10,
  });
  assert.equal(out.fresh.length, 2);
  assert.equal(out.asked, 10);
});
