import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeTurns } from "@/lib/readings/trace-signals/signals/analyze";
import { round4 } from "@/lib/readings/trace-signals/signals/build";
import { detectSequence } from "@/lib/readings/trace-signals/signals/detect-sequence";
import { wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import {
  contextFor,
  fresh,
  pairsOf,
  signalTurns,
  statsOf,
  times,
  withFloors,
} from "@/lib/readings/trace-signals/signals/test-fixtures";

function detect(
  turns: ReturnType<typeof signalTurns>,
  minTurns = 20,
  floors?: Parameters<typeof detectSequence>[2],
) {
  const stats = statsOf(turns);
  return detectSequence(stats, pairsOf(stats, turns, minTurns), floors);
}

const chain = () => fresh().search(["find"]).invoke("find").search(["assign"]).invoke("assign");
const chainNoSearch = () => fresh().search(["find", "assign"]).invoke("find").invoke("assign");
const reverse = () => fresh().search(["assign", "find"]).invoke("assign").invoke("find");
const other = () => fresh().search(["other"]).invoke("other");

test("sequence_chain: a dependency reached through a second search routes to a workflow skill", () => {
  const turns = signalTurns([...times(20, chain), ...times(40, other)]);
  const [signal] = detect(turns).signals.filter((s) => s.kind === "sequence_chain");
  assert.ok(signal);
  assert.equal(signal.subjectKey, "find>assign");
  assert.deepEqual(signal.subjectIds, ["find", "assign"]);
  assert.equal(signal.metrics.relation, "dependency");
  assert.equal(signal.metrics.viaShare, 1);
  assert.equal(signal.metrics.lift, 3);
  assert.equal(signal.route, "workflow_skill");
  assert.equal(signal.severity, round4(wilsonLow(20, 20)));
  assert.equal(signal.impact, 40);
});

test("sequence_chain: a pair run in both orders is co-occurrence, and without a search it is not a workflow", () => {
  const turns = signalTurns([
    ...times(20, chainNoSearch),
    ...times(6, reverse),
    ...times(100, other),
  ]);
  const [signal] = detect(turns).signals.filter((s) => s.subjectKey === "find>assign");
  assert.equal(signal?.metrics.relation, "co_occurrence");
  assert.equal(signal?.metrics.reverse, 6);
  assert.equal(signal?.route, "none");
});

test("sequence_chain needs the pair floor, the lift floor and eligible tools", () => {
  const few = signalTurns([...times(9, chain), ...times(40, other)]);
  assert.equal(
    detect(few, 5).signals.filter((s) => s.kind === "sequence_chain").length,
    0,
    "9 pairs < 10",
  );
  const common = signalTurns(times(20, chain));
  assert.equal(
    detect(common).signals.filter((s) => s.kind === "sequence_chain").length,
    0,
    "lift 1 when both run in every turn",
  );
  const busy = signalTurns([...times(20, chain), ...times(40, other)]);
  assert.equal(
    detect(busy, 21).signals.filter((s) => s.kind === "sequence_chain").length,
    0,
    "tools below the pair floor are skipped",
  );
});

test("no_follow_through counts ok calls followed at once by a search for the same thing", () => {
  const ask = { query: "who is Mia" };
  // The lookup did not settle it: the agent asks the same thing again at once.
  const again = () =>
    fresh()
      .search(["lookup", "members"], ask)
      .invoke("lookup")
      .search(["members", "lookup"], ask)
      .invoke("members");
  const settled = () => fresh().search(["lookup", "members"], ask).invoke("lookup");
  const turns = signalTurns([...times(10, again), ...times(10, settled)]);
  const [signal] = detect(turns).signals.filter((s) => s.kind === "no_follow_through");
  assert.equal(signal?.subjectKey, "lookup");
  assert.equal(signal?.n, 20);
  assert.equal(signal?.metrics.k, 10);
  assert.equal(signal?.severity, round4(wilsonLow(10, 20)));

  const late = signalTurns(
    times(10, () =>
      fresh()
        .search(["lookup", "members"], ask)
        .invoke("lookup")
        .end("lookup")
        .wait(60_000)
        .search(["members", "lookup"], ask)
        .invoke("members"),
    ),
  );
  assert.equal(
    detect(late).signals.filter((s) => s.kind === "no_follow_through").length,
    0,
    "a search a minute later is not immediate",
  );
});

test("a chained next step (a search for a new need right after a call) is not no_follow_through", () => {
  const turns = signalTurns([...times(20, chain), ...times(20, other)]);
  assert.equal(detect(turns).signals.filter((s) => s.kind === "no_follow_through").length, 0);
});

test("repeat_invoke fires at its floors and not below", () => {
  const thrice = () => fresh().search(["note"]).invoke("note").invoke("note").invoke("note");
  const once = () => fresh().search(["note"]).invoke("note");
  const floors = withFloors("repeat_invoke", { minLow: wilsonLow(3, 10) });
  const [signal] = detect(
    signalTurns([...times(3, thrice), ...times(7, once)]),
    20,
    floors,
  ).signals.filter((s) => s.kind === "repeat_invoke");
  assert.equal(signal?.metrics.k, 3);
  assert.equal(signal?.impact, 6);
  assert.equal(signal?.severity, round4(wilsonLow(3, 10)));
  const below = detect(signalTurns([...times(2, thrice), ...times(8, once)]), 20, floors);
  assert.equal(below.signals.filter((s) => s.kind === "repeat_invoke").length, 0);
});

test("with pass two skipped sequence_chain is not measured, the pass-one kinds still are", () => {
  const turns = signalTurns([...times(20, chain), ...times(40, other)]);
  const stats = statsOf(turns);
  const skipped = detectSequence(stats, pairsOf(stats, turns), undefined, false);
  assert.deepEqual([...skipped.measured].sort(), ["no_follow_through", "repeat_invoke"]);
  assert.equal(skipped.signals.filter((s) => s.kind === "sequence_chain").length, 0);
  assert.ok(detect(turns).measured.has("sequence_chain"), "measured once pass two ran");
});

test("a run with under two busy tools skips pass two and leaves the pair kinds unmeasured", () => {
  const quiet = signalTurns(times(30, () => fresh().search(["only"]).invoke("only")));
  const skipped = analyzeTurns(quiet, contextFor(quiet));
  assert.equal(skipped.pairTools, 1);
  assert.ok(!skipped.measured.has("sequence_chain"));
  assert.ok(!skipped.measured.has("sibling_confusion"));
  assert.ok(skipped.measured.has("no_follow_through"));
  assert.ok(skipped.measured.has("repeat_invoke"));

  const busy = signalTurns([...times(20, chain), ...times(40, other)]);
  const ran = analyzeTurns(busy, contextFor(busy));
  assert.ok(ran.measured.has("sequence_chain"));
  assert.ok(ran.measured.has("sibling_confusion"));
});
