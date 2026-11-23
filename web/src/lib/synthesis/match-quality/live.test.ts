import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluableSelection } from "@/lib/synthesis/quality/ground-truth";
import { numbersFromSelections } from "./live";

const at = new Date("2026-09-29T00:00:00Z");

function search(
  id: string,
  opts: { judged?: string; unclear?: boolean; ratel: string[]; legacy: string[] },
): EvaluableSelection {
  return {
    selectionId: id,
    occurredAt: at,
    query: `q ${id}`,
    invokedToolId: null,
    invokedRank: null,
    judgedToolId: opts.judged ?? null,
    judgedFrom: opts.judged ? "judge" : undefined,
    unclear: opts.unclear ?? false,
    arms: [
      { arm: "ratel", role: "serving", resultIds: opts.ratel },
      { arm: "legacy", role: "shadow", resultIds: opts.legacy },
    ],
  };
}

test("each engine is scored on its own against the answer key, unanswered left out", () => {
  const view = numbersFromSelections(
    [
      search("a", { judged: "t1", ratel: ["t2", "t1"], legacy: ["t1"] }),
      search("b", { judged: "t3", ratel: ["t3"], legacy: ["t4"] }),
      search("c", { unclear: true, ratel: ["t5"], legacy: ["t5"] }),
      search("d", { ratel: ["t6"], legacy: ["t6"] }),
    ],
    "ratel",
    "legacy",
  );
  assert.deepEqual(view?.ours, { arm: "ratel", top1: 0.5, containment: 1, n: 2 });
  assert.deepEqual(view?.theirs, { arm: "legacy", top1: 0.5, containment: 0.5, n: 2 });
  assert.deepEqual(view?.coverage, { searches: 4, answered: 2, unclear: 1, unread: 1 });
});

test("with no answers there are no engine numbers, only coverage", () => {
  const view = numbersFromSelections([search("a", { ratel: ["t1"], legacy: ["t1"] })], null, null);
  assert.equal(view?.ours, null);
  assert.equal(view?.theirs, null);
  assert.equal(view?.coverage.unread, 1);
});

test("one engine (no calibration) gives our number and no incumbent", () => {
  const single = (id: string, judged: string, ratel: string[]): EvaluableSelection => ({
    selectionId: id,
    occurredAt: at,
    query: `q ${id}`,
    invokedToolId: null,
    invokedRank: null,
    judgedToolId: judged,
    judgedFrom: "judge",
    arms: [{ arm: "ratel", role: "serving", resultIds: ratel }],
  });
  const view = numbersFromSelections(
    [single("a", "t1", ["t1"]), single("b", "t2", ["t3", "t2"])],
    null,
    null,
  );
  assert.deepEqual(view?.ours, { arm: "ratel", top1: 0.5, containment: 1, n: 2 });
  assert.equal(view?.theirs, null);
});
