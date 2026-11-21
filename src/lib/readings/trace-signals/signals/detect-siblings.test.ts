import assert from "node:assert/strict";
import { test } from "node:test";
import { round4 } from "@/lib/readings/trace-signals/signals/build";
import { detectSiblings } from "@/lib/readings/trace-signals/signals/detect-siblings";
import { wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import {
  fresh,
  pairsOf,
  signalTurns,
  statsOf,
  times,
} from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { CatalogEntryFact } from "@/lib/readings/trace-signals/signals/types";

const unlinkFirst = () =>
  fresh().search(["unlink_pr", "delete_rel"]).invoke("unlink_pr").invoke("delete_rel");
const deleteFirst = () =>
  fresh().search(["delete_rel", "unlink_pr"]).invoke("delete_rel").invoke("unlink_pr");
const unlinkOnly = () => fresh().search(["unlink_pr", "delete_rel"]).invoke("unlink_pr");

const CATALOG: CatalogEntryFact[] = [
  {
    kind: "tool",
    entryId: "unlink_pr",
    name: "unlink_pr",
    searchable: "Remove a pull request link from a task",
  },
  {
    kind: "tool",
    entryId: "delete_rel",
    name: "delete_rel",
    searchable: "Remove a link between two tasks",
  },
];

function detect(turns: ReturnType<typeof signalTurns>, catalog: CatalogEntryFact[] = []) {
  const stats = statsOf(turns);
  return detectSiblings(stats, pairsOf(stats, turns), catalog).signals;
}

test("sibling_confusion fires when the pair is listed together, split and swapped", () => {
  const [signal] = detect(
    signalTurns([...times(10, unlinkFirst), ...times(10, deleteFirst)]),
    CATALOG,
  );
  assert.ok(signal);
  assert.equal(signal.subjectKey, "delete_rel|unlink_pr");
  assert.deepEqual(signal.subjectIds, ["delete_rel", "unlink_pr"]);
  assert.equal(signal.metrics.swaps, 20);
  assert.equal(signal.metrics.split, 0.5);
  assert.equal(signal.metrics.coHitShare, 1);
  assert.equal(signal.severity, round4(wilsonLow(20, 20)));
  assert.equal(
    typeof signal.metrics.textJaccard,
    "number",
    "text overlap is carried, not used to fire",
  );
});

test("sibling_confusion stays quiet when one tool always wins or swaps are too few", () => {
  assert.equal(
    detect(signalTurns([...times(18, unlinkOnly), ...times(4, unlinkFirst)])).length,
    0,
    "4 swaps < 5",
  );
  const lopsided = signalTurns([
    ...times(19, unlinkFirst),
    ...times(1, deleteFirst),
    ...times(20, unlinkOnly),
  ]);
  assert.equal(detect(lopsided).length, 0, "split 1/40 < 0.2");
});

test("sibling_confusion is not measured when pass two never ran", () => {
  const turns = signalTurns([...times(10, unlinkFirst), ...times(10, deleteFirst)]);
  const stats = statsOf(turns);
  const skipped = detectSiblings(stats, pairsOf(stats, turns), CATALOG, undefined, false);
  assert.deepEqual(skipped, { signals: [], measured: new Set() });
});
