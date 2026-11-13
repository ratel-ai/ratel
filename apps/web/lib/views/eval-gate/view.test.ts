import assert from "node:assert/strict";
import { test } from "node:test";
import { methodForKind } from "./method";
import { MIN_REPLAY_FIDELITY } from "./score";
import { type HowItRanInput, howItRan } from "./view";

const RANKED = /ranked again/;
const REPLAYED = /replayed by a model/;
const minFidelity = MIN_REPLAY_FIDELITY;
const latest = (over: Partial<NonNullable<HowItRanInput["latest"]>>): HowItRanInput["latest"] => ({
  method: null,
  verdict: null,
  fidelity: null,
  judge: null,
  ...over,
});

/* RC-77: the eval page named the search engine for a merge that hadn't run yet. */

test("before any run, a merge reads as model replay, never a re-rank", () => {
  const line = howItRan({ planned: methodForKind("merge"), latest: null, minFidelity });
  assert.match(line, REPLAYED);
  assert.doesNotMatch(line, RANKED);
});

test("before any run, each kind names the method it uses", () => {
  for (const kind of [
    "merge",
    "combine",
    "fold",
    "enrich",
    "parallel",
    "prerequisite",
    "skill",
    "fail-clearly",
    "schema",
  ]) {
    assert.match(
      howItRan({ planned: methodForKind(kind), latest: null, minFidelity }),
      REPLAYED,
      kind,
    );
  }
  for (const kind of ["rewrite", "tell-apart", "retire", "fewer-results"]) {
    const line = howItRan({ planned: methodForKind(kind), latest: null, minFidelity });
    assert.match(line, RANKED, kind);
    assert.doesNotMatch(line, REPLAYED, kind);
  }
  for (const kind of ["build", "split", "preload"]) {
    const line = howItRan({ planned: methodForKind(kind), latest: null, minFidelity });
    assert.match(line, /Can't simulate/, kind);
    assert.doesNotMatch(line, RANKED, kind);
  }
});

test("after a run, the method the run used is named", () => {
  assert.match(
    howItRan({ planned: "rerank", latest: latest({ method: "rerank" }), minFidelity }),
    RANKED,
  );
  const replayed = howItRan({
    planned: "replay",
    latest: latest({ method: "replay", fidelity: { matched: 8, total: 10 } }),
    minFidelity,
  });
  assert.match(replayed, REPLAYED);
  assert.match(replayed, /recorded path in 8 of 10 runs/);
});

test("a merge run where nothing could be replayed still says it needs replay, and why there's no verdict", () => {
  const line = howItRan({
    planned: "replay",
    latest: latest({ method: "none", verdict: "unreliable" }),
    minFidelity,
  });
  assert.match(line, /needs model replay/);
  assert.match(line, /gives no verdict/);
  assert.doesNotMatch(line, RANKED);
  // With a fidelity reading, the threshold is named.
  const measured = howItRan({
    planned: "replay",
    latest: latest({
      method: "replay",
      verdict: "unreliable",
      fidelity: { matched: 1, total: 10 },
    }),
    minFidelity,
  });
  assert.match(measured, /under 50%/);
});

test("the judge's status follows the method", () => {
  assert.match(
    howItRan({
      planned: "rerank",
      latest: latest({ method: "rerank", judge: "Criteria not judged: no model configured" }),
      minFidelity,
    }),
    /no model configured\.$/,
  );
});
