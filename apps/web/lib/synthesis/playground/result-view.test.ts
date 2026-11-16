import assert from "node:assert/strict";
import { test } from "node:test";
import { changeSummary, emptyReason, movementWords, resultList, verdict } from "./result-view";
import type { PlaygroundRun } from "./run";
import { RANKED_HIT_DEFAULTS } from "./test-support";
import type { RankedHit } from "./types";

const hit = (id: string, score: number, edited = false): RankedHit => ({
  ...RANKED_HIT_DEFAULTS,
  id,
  kind: "tool",
  rank: 0,
  score,
  bm25Score: null,
  embeddingScore: null,
  description: `${id} description`,
  edited,
});

const emptyDiff = { entries: [], summary: { moved: 0, added: 0, dropped: 0, stable: 0 } };

function run(saved: RankedHit[], drafted: RankedHit[] | null): PlaygroundRun {
  return {
    baseline: { skills: [], tools: saved },
    drafted: { skills: [], tools: drafted ?? saved },
    diff: { skills: emptyDiff, tools: emptyDiff },
    changes: [],
    hasEdits: drafted !== null,
  } as unknown as PlaygroundRun;
}

test("with no changes, rows carry no movement and strength is a share of the first pick", () => {
  const list = resultList(run([hit("weather", 4), hit("book_flight", 3)], null), "tool");
  assert.deepEqual(
    list.rows.map((row) => [row.hit.id, row.rank, row.movement, row.strength]),
    [
      ["weather", 1, null, 1],
      ["book_flight", 2, null, 0.75],
    ],
  );
  assert.deepEqual(list.pushedOut, []);
});

test("with changes, rows move against the saved catalog and dropped ones are reported", () => {
  const list = resultList(
    run(
      [hit("weather", 4), hit("tier", 3.6), hit("book_flight", 3.4)],
      [hit("book_flight", 6, true), hit("weather", 4), hit("hotel", 2)],
    ),
    "tool",
  );
  assert.deepEqual(
    list.rows.map((row) => [row.hit.id, row.movement]),
    [
      ["book_flight", { kind: "up", places: 2 }],
      ["weather", { kind: "down", places: 1 }],
      ["hotel", { kind: "new" }],
    ],
  );
  assert.deepEqual(
    list.pushedOut.map((pushed) => pushed.id),
    ["tier"],
  );
  assert.deepEqual(changeSummary(list, new Set(["book_flight"])), [
    { tone: "success", text: "book_flight moved up to #1 (was #3)." },
  ]);
});

test("changeSummary reports a changed capability that fell out", () => {
  const list = resultList(run([hit("a", 2), hit("b", 1)], [hit("a", 2)]), "tool");
  assert.deepEqual(changeSummary(list, new Set(["b"])), [
    { tone: "warning", text: "b dropped out of the list." },
  ]);
});

test("verdict says nothing until the reader names a tool, then says where it landed", () => {
  const list = resultList(run([hit("weather", 4), hit("book_flight", 3)], null), "tool");
  assert.equal(verdict({ list, expected: null, top: 5, sharesWords: true }), null);
  assert.deepEqual(verdict({ list, expected: "weather", top: 5, sharesWords: true }), {
    tone: "success",
    text: "weather comes first.",
  });
  assert.equal(
    verdict({ list, expected: "book_flight", top: 5, sharesWords: true })?.text,
    "book_flight comes #2.",
  );
  assert.match(
    verdict({ list, expected: "hotel", top: 5, sharesWords: false })?.text ?? "",
    /no words in common/,
  );
  assert.equal(
    verdict({ list, expected: "hotel", top: 5, sharesWords: true })?.text,
    "hotel isn't in the top 5.",
  );
});

test("a change to the expected tool is told once, in the verdict, with where it was", () => {
  const list = resultList(
    run(
      [hit("weather", 4), hit("book_flight", 3)],
      [hit("book_flight", 6, true), hit("weather", 4)],
    ),
    "tool",
  );
  assert.equal(
    verdict({ list, expected: "book_flight", top: 5, sharesWords: true })?.text,
    "book_flight comes first (was #2).",
  );
  assert.deepEqual(changeSummary(list, new Set(["book_flight"]), "book_flight"), []);
});

test("emptyReason never suggests matching by meaning when it is unavailable", () => {
  const empty = resultList(run([], null), "tool");
  assert.equal(emptyReason(empty, 0, "bm25", true), "No tools in this catalog yet.");
  assert.match(emptyReason(empty, 3, "bm25", true) ?? "", /match by meaning/);
  assert.doesNotMatch(emptyReason(empty, 3, "bm25", false) ?? "", /meaning/);
  assert.match(emptyReason(empty, 3, "embeddings", true) ?? "", /could be scored/);
  assert.equal(emptyReason(resultList(run([hit("a", 1)], null), "tool"), 1, "bm25", true), null);
});

test("movementWords reads as plain words", () => {
  assert.equal(movementWords({ kind: "up", places: 2 }), "Up 2");
  assert.equal(movementWords({ kind: "new" }), "New");
});
