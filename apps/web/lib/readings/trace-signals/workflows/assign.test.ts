import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignTurn,
  jaccard,
  matchPrevious,
  matchScore,
} from "@/lib/readings/trace-signals/workflows/assign";
import { mineWorkflows } from "@/lib/readings/trace-signals/workflows/mine";
import { workflowFingerprint } from "@/lib/readings/trace-signals/workflows/order";
import { many, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";
import type { WorkflowCore } from "@/lib/readings/trace-signals/workflows/types";

const core = (...tools: string[]): WorkflowCore => ({
  id: workflowFingerprint(tools),
  coreTools: [...tools].sort(),
});

test("matchScore: contained scores 1, a near miss scores its weighted Jaccard, a far one is null", () => {
  assert.deepEqual(matchScore(new Set(["a", "b", "c", "x"]), ["a", "b", "c"]), {
    contained: true,
    score: 1,
    coreWeight: 3,
  });
  const near = matchScore(new Set(["a", "b", "c"]), ["a", "b", "c", "d"]);
  assert.equal(near?.contained, false);
  assert.equal(near?.score, 0.75);
  assert.equal(matchScore(new Set(["a"]), ["a", "b", "c", "d"]), null);
  const weighted = matchScore(new Set(["a", "b", "c"]), ["a", "b", "c", "d"], {
    weights: { a: 1, b: 1, c: 1, d: 3 },
  });
  assert.equal(weighted, null, "missing the heavy tool drops the match to 3/6");
});

test("assignTurn: a contained core beats a Jaccard match, and the more specific contained core wins", () => {
  const plan = core("list", "backlog", "estimate", "assign");
  const small = core("list", "backlog");
  const close = core("find", "update", "notify");
  const workflows = [small, plan, close];
  assert.deepEqual(assignTurn(["list", "backlog", "estimate", "assign", "extra"], workflows), {
    workflowId: plan.id,
    score: 1,
  });
  assert.deepEqual(assignTurn(["list", "backlog"], workflows), { workflowId: small.id, score: 1 });
  assert.deepEqual(assignTurn(["find", "update"], workflows), {
    workflowId: close.id,
    score: 2 / 3,
  });
  assert.equal(assignTurn(["unrelated", "tools"], workflows), null);
  assert.equal(assignTurn([], workflows), null);
});

test("assignTurn places new turns in mined workflows the way mining did", () => {
  const turns = [
    ...many(40, () => wfTurn(["a", "b", "c"])),
    ...many(40, () => wfTurn(["d", "e", "f"])),
  ];
  const result = mineWorkflows(turns);
  const abc = result.workflows.find((w) => w.coreTools.includes("a"))!;
  assert.equal(
    assignTurn(["c", "a", "b"], result.workflows, { weights: result.idf })?.workflowId,
    abc.id,
  );
  assert.equal(
    assignTurn(["a", "b"], result.workflows, { weights: result.idf })?.workflowId,
    abc.id,
  );
  assert.equal(assignTurn(["a", "d"], result.workflows, { weights: result.idf }), null);
});

test("jaccard of tool lists", () => {
  assert.equal(jaccard(["a", "b"], ["b", "a"]), 1);
  assert.equal(jaccard(["a", "b", "c", "d"], ["a", "b", "c", "d", "e"]), 0.8);
  assert.equal(jaccard([], []), 0);
});

test("matchPrevious keeps ids across a one-tool drift, one to one, and leaves new workflows out", () => {
  const previous: WorkflowCore[] = [
    { id: "wf-plan", coreTools: ["assign", "backlog", "estimate", "list"] },
    { id: "wf-close", coreTools: ["find", "notify", "update"] },
    { id: "wf-report", coreTools: ["export", "fetch", "summarize"] },
  ];
  const grown = core("assign", "backlog", "estimate", "list", "notify_team");
  const shrunk = core("find", "update", "notify", "link");
  const fresh = core("invite", "create_task");
  const same = core("export", "fetch", "summarize");
  const map = matchPrevious([grown, shrunk, fresh, same], previous);
  assert.equal(map.get(grown.id), "wf-plan", "4 of 5 shared");
  assert.equal(map.get(shrunk.id), "wf-close", "3 of 4 shared");
  assert.equal(map.get(same.id), "wf-report");
  assert.equal(map.has(fresh.id), false);
  const twoTools = matchPrevious([core("a", "b", "c")], [{ id: "old", coreTools: ["a", "b"] }]);
  assert.equal(twoTools.size, 0, "2 of 3 is below 0.7");
});

test("matchPrevious gives a previous id to one workflow only, the closest", () => {
  const previous: WorkflowCore[] = [{ id: "old", coreTools: ["a", "b", "c", "d"] }];
  const exact = core("a", "b", "c", "d");
  const drifted = core("a", "b", "c", "d", "e");
  const map = matchPrevious([drifted, exact], previous);
  assert.equal(map.get(exact.id), "old");
  assert.equal(map.has(drifted.id), false);
});

test("a mined workflow keeps its previous id when one tool joins its core", () => {
  const before = mineWorkflows([
    ...many(60, () => wfTurn(["a", "b", "c", "d"])),
    ...many(30, (i) => wfTurn([`n${i}`, `m${i}`])),
  ]);
  const after = mineWorkflows([
    ...many(60, () => wfTurn(["a", "b", "c", "d", "e"])),
    ...many(30, (i) => wfTurn([`n${i}`, `m${i}`])),
  ]);
  const previous = before.workflows.map((w) => ({ id: `named-${w.id}`, coreTools: w.coreTools }));
  const map = matchPrevious(after.workflows, previous);
  assert.notEqual(after.workflows[0]!.id, before.workflows[0]!.id, "the fingerprint changed");
  assert.equal(map.get(after.workflows[0]!.id), `named-${before.workflows[0]!.id}`);
});
