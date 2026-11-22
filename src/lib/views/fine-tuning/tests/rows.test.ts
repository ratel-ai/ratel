import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Scorer } from "../../task-scorers/types";
import { emptyCounts } from "../domain/redaction";
import {
  type BuildContext,
  type BuildSettings,
  buildRows,
  buildSettings,
  type CandidateCall,
  type CandidateTurn,
  callOrder,
  type DatasetRow,
  DatasetRowBuilder,
  emptyDrops,
  forcedEvalGroups,
  splitGroups,
} from "../domain/rows";
import type { UseCaseSelector } from "../domain/use-case";

/** RC-1127: the pure row pipeline. Expected values are written by hand. */

const SELECTOR: UseCaseSelector = { taskIds: ["triage"], intentIds: [] };
const NO_CONTEXT = {
  scorersByTask: new Map<string, Scorer[]>(),
  pinned: new Set<string>(),
  excluded: new Set<string>(),
  evalCaseTurnIds: new Set<string>(),
};
const settings = (input: Parameters<typeof buildSettings>[1] = {}) =>
  buildSettings(SELECTOR, { evalFraction: 0, ...input });

let clock = Date.parse("2026-11-01T00:00:00Z");
function call(spanId: string, ask: string, reply = "ok", traceId = "t1"): CandidateCall {
  clock += 1000;
  return {
    traceId,
    spanId,
    eventId: `e-${spanId}`,
    capturedAt: new Date(clock),
    content: {
      messages: [{ role: "user", content: ask }],
      output: [{ role: "assistant", content: reply }],
    },
  };
}

function turn(
  turnId: string,
  calls: CandidateCall[],
  extra: Partial<CandidateTurn> = {},
): CandidateTurn {
  return {
    turnId,
    taskId: "triage",
    sessionId: `s-${turnId}`,
    endUserKey: null,
    errorCount: 0,
    selfCorrections: 0,
    scorerRun: { firstList: null, searches: null, calls: ["search"], failed: 0 },
    userScores: [],
    calls,
    ...extra,
  };
}

const spans = (rows: { spanId: string }[]) => rows.map((row) => row.spanId);

test("a turn that fails one enabled scorer is dropped; judge_criteria is skipped", () => {
  const scorersByTask = new Map<string, Scorer[]>([
    [
      "triage",
      [
        { kind: "max_tool_calls", max: 2 },
        { kind: "judge_criteria", criteria: "be nice" },
      ],
    ],
  ]);
  const result = buildRows(
    [
      turn("good", [call("a", "one")], {
        scorerRun: {
          firstList: null,
          searches: null,
          calls: ["x"],
          failed: 0,
          criteriaPass: false,
        },
      }),
      turn("busy", [call("b", "two"), call("c", "three")], {
        scorerRun: { firstList: null, searches: null, calls: ["x", "y", "z"], failed: 0 },
      }),
    ],
    settings(),
    { ...NO_CONTEXT, scorersByTask },
  );
  assert.deepEqual(spans(result.rows), ["a"]);
  assert.deepEqual(result.dropped, { ...emptyDrops(), scorer_failed: 2 });
});

test("a pinned turn passes the filter; an excluded turn never enters, even when pinned too", () => {
  const scorersByTask = new Map<string, Scorer[]>([
    ["triage", [{ kind: "max_tool_calls", max: 0 }]],
  ]);
  const result = buildRows(
    [
      turn("pinned", [call("a", "one")]),
      turn("excluded", [call("b", "two")]),
      turn("both", [call("c", "three")]),
      turn("plain", [call("d", "four")]),
    ],
    settings(),
    {
      ...NO_CONTEXT,
      scorersByTask,
      pinned: new Set(["pinned", "both"]),
      excluded: new Set(["excluded", "both"]),
    },
  );
  assert.deepEqual(spans(result.rows), ["a"]);
  assert.deepEqual(result.dropped, { ...emptyDrops(), excluded: 2, scorer_failed: 1 });
});

test("a pinned or excluded call key acts on that call only", () => {
  const scorersByTask = new Map<string, Scorer[]>([
    ["triage", [{ kind: "max_tool_calls", max: 0 }]],
  ]);
  const result = buildRows(
    [turn("t", [call("a", "one"), call("b", "two"), call("c", "three")])],
    settings(),
    {
      ...NO_CONTEXT,
      scorersByTask,
      pinned: new Set(["t1:a"]),
      excluded: new Set(["t1:c"]),
    },
  );
  assert.deepEqual(spans(result.rows), ["a"]);
  assert.deepEqual(result.dropped, { ...emptyDrops(), scorer_failed: 1, excluded: 1 });
});

test("user scorer fails, errors and self-corrections drop per their rule; skip does not drop", () => {
  const turns = [
    turn("user-fail", [call("a", "one")], { userScores: [{ status: "pass" }, { status: "fail" }] }),
    turn("user-skip", [call("b", "two")], { userScores: [{ status: "skip" }] }),
    turn("errored", [call("c", "three")], { errorCount: 2 }),
    turn("corrected", [call("d", "four")], { selfCorrections: 1 }),
  ];
  const strict = buildRows(
    turns,
    settings({ filters: { noError: true, noSelfCorrection: true } }),
    NO_CONTEXT,
  );
  assert.deepEqual(spans(strict.rows), ["b"]);
  assert.deepEqual(strict.dropped, {
    ...emptyDrops(),
    user_scorer_failed: 1,
    error: 1,
    self_correction: 1,
  });

  const loose = buildRows(turns, settings(), NO_CONTEXT);
  assert.deepEqual(spans(loose.rows), ["b", "c", "d"]);
});

test("a call with no stored content or no reply is dropped with its reason", () => {
  const empty: CandidateCall = { ...call("a", "x"), content: null };
  const noReply: CandidateCall = {
    ...call("b", "y"),
    content: { messages: [{ role: "user", content: "y" }] },
  };
  const result = buildRows([turn("t", [empty, noReply, call("c", "z")])], settings(), NO_CONTEXT);
  assert.deepEqual(spans(result.rows), ["c"]);
  assert.deepEqual(result.dropped, { ...emptyDrops(), no_content: 1, no_output: 1 });
});

test("the reply comes from the messages after input_message_count when the call has no output", () => {
  const legacy: CandidateCall = {
    ...call("a", "x"),
    content: {
      input_message_count: 1,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    },
  };
  const [row] = buildRows([turn("t", [legacy])], settings(), NO_CONTEXT).rows;
  assert.deepEqual(row?.content, {
    messages: [{ role: "user", content: "hi" }],
    output: [{ role: "assistant", content: "hello" }],
  });
});

test("dedup: exact drops same input, near also drops case, space and digit variants; the earliest stays", () => {
  const turns = () => [
    turn("t1", [call("first", "Order 1234 is late")]),
    turn("t2", [call("copy", "Order 1234 is late", "a different reply")]),
    turn("t3", [call("variant", "order   9876 IS late")]),
    turn("t4", [call("other", "Where is my refund?")]),
  ];
  const off = buildRows(turns(), settings({ dedup: "off" }), NO_CONTEXT);
  assert.deepEqual(spans(off.rows), ["first", "copy", "variant", "other"]);

  const exact = buildRows(turns(), settings({ dedup: "exact" }), NO_CONTEXT);
  assert.deepEqual(spans(exact.rows), ["first", "variant", "other"]);
  assert.deepEqual(exact.dropped, { ...emptyDrops(), duplicate_exact: 1 });

  const near = buildRows(turns(), settings({ dedup: "near" }), NO_CONTEXT);
  assert.deepEqual(spans(near.rows), ["first", "other"]);
  assert.deepEqual(near.dropped, { ...emptyDrops(), duplicate_exact: 1, duplicate_near: 1 });
});

test("dedup keeps the earliest call even when turns arrive newest first", () => {
  const early = call("early", "same ask");
  const late = call("late", "same ask");
  const result = buildRows(
    [turn("newer", [late]), turn("older", [early])],
    settings({ dedup: "exact" }),
    NO_CONTEXT,
  );
  assert.deepEqual(spans(result.rows), ["early"]);
});

test("rows are redacted before dedup; the redaction report sums kept rows", () => {
  const result = buildRows(
    [
      turn("t1", [call("a", "I am anna@example.com", "noted anna@example.com")]),
      turn("t2", [call("b", "I am bob@example.com")]),
    ],
    settings({ dedup: "exact" }),
    NO_CONTEXT,
  );
  assert.deepEqual(spans(result.rows), ["a"]);
  assert.deepEqual(result.rows[0]?.content, {
    messages: [{ role: "user", content: "I am [EMAIL_1]" }],
    output: [{ role: "assistant", content: "noted [EMAIL_1]" }],
  });
  assert.deepEqual(result.redaction, { ...emptyCounts(), email: 2 });
  assert.equal(JSON.stringify(result.rows).includes("example.com"), false);
});

test("rows carry their source, ordinal and side", () => {
  const c = call("span-9", "hello", "hi", "trace-9");
  const [row] = buildRows([turn("turn-9", [c])], settings(), NO_CONTEXT).rows;
  assert.deepEqual(
    {
      ordinal: row?.ordinal,
      side: row?.side,
      traceId: row?.traceId,
      spanId: row?.spanId,
      turnId: row?.turnId,
      capturedAt: row?.capturedAt,
    },
    {
      ordinal: 0,
      side: "train",
      traceId: "trace-9",
      spanId: "span-9",
      turnId: "turn-9",
      capturedAt: c.capturedAt,
    },
  );
});

test("the row hash and the content hash follow their written definition", () => {
  const result = buildRows([turn("t", [call("a", "hi", "yo")])], settings(), NO_CONTEXT);
  const canonical =
    '{"content":{"messages":[{"content":"hi","role":"user"}],"output":[{"content":"yo","role":"assistant"}]},"side":"train"}';
  const rowHash = createHash("sha256").update(canonical).digest("hex");
  assert.equal(result.rows[0]?.rowHash, rowHash);
  assert.equal(result.contentHash, createHash("sha256").update(rowHash).digest("hex"));
});

/**
 * The split invariant, checked on the output rows only: the session ids and
 * the end-user keys of the train rows and of the eval rows share no value.
 */
function assertNoIdOnBothSides(
  rows: readonly DatasetRow[],
  turns: readonly CandidateTurn[],
  label = "",
) {
  const byTurn = new Map(turns.map((t) => [t.turnId, t]));
  for (const id of ["sessionId", "endUserKey"] as const) {
    const sides = { train: new Set<string>(), eval: new Set<string>() };
    for (const row of rows) {
      const value = byTurn.get(row.turnId)![id];
      if (value !== null) sides[row.side].add(value);
    }
    const both = [...sides.train].filter((value) => sides.eval.has(value));
    assert.deepEqual(both, [], `${id} on both sides ${label}`);
  }
}

/** Seeds until one gives both sides, so a split case is not passed by a one-sided build. */
function buildOnBothSides(turns: CandidateTurn[], evalFraction = 0.5) {
  for (let seed = 0; seed < 200; seed += 1) {
    const result = buildRows(turns, settings({ seed, evalFraction, dedup: "off" }), NO_CONTEXT);
    const sides = new Set(result.rows.map((row) => row.side));
    if (sides.size === 2) return result;
  }
  throw new Error("no seed split these turns");
}

test("one end user across two sessions stays on one side", () => {
  const turns = [
    turn("a1", [call("a1", "one")], { sessionId: "A", endUserKey: "u1" }),
    turn("b1", [call("b1", "two")], { sessionId: "B", endUserKey: "u1" }),
    turn("c1", [call("c1", "three")], { sessionId: "C", endUserKey: "u9" }),
    turn("d1", [call("d1", "four")], { sessionId: "D", endUserKey: "u8" }),
  ];
  for (let seed = 0; seed < 50; seed += 1) {
    const result = buildRows(
      turns,
      settings({ seed, evalFraction: 0.5, dedup: "off" }),
      NO_CONTEXT,
    );
    assertNoIdOnBothSides(result.rows, turns, `seed ${seed}`);
    const a = result.rows.find((row) => row.turnId === "a1")!.side;
    assert.equal(result.rows.find((row) => row.turnId === "b1")!.side, a);
  }
  buildOnBothSides(turns);
});

test("one session with two end users stays on one side", () => {
  const turns = [
    turn("s1", [call("s1", "one")], { sessionId: "S", endUserKey: "u1" }),
    turn("s2", [call("s2", "two")], { sessionId: "S", endUserKey: "u2" }),
    turn("x1", [call("x1", "three")], { sessionId: "X", endUserKey: "u3" }),
    turn("y1", [call("y1", "four")], { sessionId: "Y", endUserKey: "u4" }),
  ];
  for (let seed = 0; seed < 50; seed += 1) {
    const result = buildRows(
      turns,
      settings({ seed, evalFraction: 0.5, dedup: "off" }),
      NO_CONTEXT,
    );
    assertNoIdOnBothSides(result.rows, turns, `seed ${seed}`);
    assert.equal(
      result.rows.find((row) => row.turnId === "s1")!.side,
      result.rows.find((row) => row.turnId === "s2")!.side,
    );
  }
});

test("a chain: sessions A and B share user 1, B and C share user 2: all three stay on one side", () => {
  const turns = [
    turn("a", [call("a", "one")], { sessionId: "A", endUserKey: "u1" }),
    turn("b1", [call("b1", "two")], { sessionId: "B", endUserKey: "u1" }),
    turn("b2", [call("b2", "three")], { sessionId: "B", endUserKey: "u2" }),
    turn("c", [call("c", "four")], { sessionId: "C", endUserKey: "u2" }),
    turn("z", [call("z", "five")], { sessionId: "Z", endUserKey: "u7" }),
  ];
  for (let seed = 0; seed < 50; seed += 1) {
    const result = buildRows(
      turns,
      settings({ seed, evalFraction: 0.5, dedup: "off" }),
      NO_CONTEXT,
    );
    assertNoIdOnBothSides(result.rows, turns, `seed ${seed}`);
    const sides = new Set(
      result.rows
        .filter((row) => ["a", "b1", "b2", "c"].includes(row.turnId))
        .map((row) => row.side),
    );
    assert.equal(sides.size, 1, `seed ${seed}`);
  }
});

test("missing keys: a null never joins turns; a turn with neither key is its own group", () => {
  const turns = [
    turn("n1", [call("n1", "one")], { sessionId: null, endUserKey: null }),
    turn("n2", [call("n2", "two")], { sessionId: null, endUserKey: null }),
    turn("s-only", [call("s-only", "three")], { sessionId: "S", endUserKey: null }),
    turn("s-too", [call("s-too", "four")], { sessionId: "S", endUserKey: null }),
    turn("u-only", [call("u-only", "five")], { sessionId: null, endUserKey: "u1" }),
    turn("u-too", [call("u-too", "six")], { sessionId: "T", endUserKey: "u1" }),
  ];
  const groups = splitGroups(turns);
  assert.deepEqual(Object.fromEntries(groups), {
    n1: "group:n1",
    n2: "group:n2",
    "s-only": "group:s-only",
    "s-too": "group:s-only",
    "u-only": "group:u-only",
    "u-too": "group:u-only",
  });
  for (let seed = 0; seed < 50; seed += 1) {
    assertNoIdOnBothSides(
      buildRows(turns, settings({ seed, evalFraction: 0.5, dedup: "off" }), NO_CONTEXT).rows,
      turns,
      `seed ${seed}`,
    );
  }
  // Two turns with no key can land on different sides: nulls do not join them.
  assert.ok(
    Array.from({ length: 50 }, (_, seed) =>
      buildRows([turns[0]!, turns[1]!], settings({ seed, evalFraction: 0.5 }), NO_CONTEXT)
        .rows.map((row) => row.side)
        .join(),
    ).some((sides) => sides === "train,eval" || sides === "eval,train"),
  );
});

test("a turn in task_eval_cases puts its whole connected group on the eval side", () => {
  const turns = [
    turn("case", [call("a", "one")], { sessionId: "shared", endUserKey: "u1" }),
    turn("sibling", [call("b", "two")], { sessionId: "other-session", endUserKey: "u1" }),
    turn("alone", [call("c", "three")], { sessionId: "other", endUserKey: "u2" }),
  ];
  const result = buildRows(turns, settings({ evalFraction: 0 }), {
    ...NO_CONTEXT,
    evalCaseTurnIds: new Set(["case"]),
  });
  assert.deepEqual(
    result.rows.map((row) => [row.spanId, row.side]),
    [
      ["a", "eval"],
      ["b", "eval"],
      ["c", "train"],
    ],
  );
  assert.deepEqual([...forcedEvalGroups(splitGroups(turns), new Set(["case"]))], ["group:case"]);
});

test("eval fraction 0 puts every row in train, 1 puts every row in eval", () => {
  const turns = () => [turn("a", [call("a", "one")]), turn("b", [call("b", "two")])];
  assert.deepEqual(
    buildRows(turns(), settings({ evalFraction: 0 }), NO_CONTEXT).rows.map((row) => row.side),
    ["train", "train"],
  );
  assert.deepEqual(
    buildRows(turns(), settings({ evalFraction: 1 }), NO_CONTEXT).rows.map((row) => row.side),
    ["eval", "eval"],
  );
});

/** A small seeded generator, so the property test is repeatable. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Ten random letters: digits would collide under near dedup. */
function word(random: () => number): string {
  return Array.from({ length: 10 }, () => String.fromCharCode(97 + Math.floor(random() * 26))).join(
    "",
  );
}

function randomTurns(random: () => number, count: number): CandidateTurn[] {
  return Array.from({ length: count }, (_, i) => {
    const session = random() < 0.15 ? null : `s${Math.floor(random() * 25)}`;
    const user = random() < 0.25 ? null : `u${Math.floor(random() * 20)}`;
    return turn(
      `r${i}`,
      [
        call(`r${i}-a`, `ask ${word(random)}`, "ok", `tr${i}`),
        call(`r${i}-b`, `follow ${word(random)}`, "ok", `tr${i}`),
      ],
      {
        sessionId: session,
        endUserKey: user,
      },
    );
  });
}

test("property: over random turns with both keys and random nulls, no session id and no end-user key is on both sides", () => {
  for (let run = 0; run < 60; run += 1) {
    const random = lcg(run + 1);
    const turns = randomTurns(random, 60);
    const evalCases = new Set(turns.filter(() => random() < 0.05).map((t) => t.turnId));
    const result = buildRows(turns, settings({ seed: run, evalFraction: 0.3, dedup: "off" }), {
      ...NO_CONTEXT,
      evalCaseTurnIds: evalCases,
    });
    assertNoIdOnBothSides(result.rows, turns, `run ${run}`);
    for (const row of result.rows) if (evalCases.has(row.turnId)) assert.equal(row.side, "eval");
  }
});

test("the same turns in another order give the same rows, sides and content hash", () => {
  const turns = randomTurns(lcg(11), 50);
  const s = settings({ seed: 5, evalFraction: 0.3 });
  const forward = buildRows(turns, s, NO_CONTEXT);
  const shuffled = [...turns].reverse().map((t) => ({ ...t, calls: [...t.calls].reverse() }));
  const backward = buildRows(shuffled, s, NO_CONTEXT);
  assert.deepEqual(backward.rows, forward.rows);
  assert.equal(backward.contentHash, forward.contentHash);
});

test("the same input and settings give the same rows, sides and content hash; another seed changes the split", () => {
  const turns = randomTurns(lcg(7), 80);
  const s: BuildSettings = settings({ seed: 1, evalFraction: 0.5 });
  const first = buildRows(turns, s, NO_CONTEXT);
  const again = buildRows(structuredClone(turns), s, NO_CONTEXT);
  assert.deepEqual(again, first);

  const reseeded = buildRows(turns, { ...s, seed: 2 }, NO_CONTEXT);
  assert.notDeepEqual(
    reseeded.rows.map((row) => row.side),
    first.rows.map((row) => row.side),
  );
  assert.notEqual(reseeded.contentHash, first.contentHash);
});

test("a build in pages that resumes from its stored rows gives the rows of a build in one go", () => {
  const turns = randomTurns(lcg(3), 30);
  turns.push(turn("dup", [call("dup-a", "ask 0 dup")]), turn("dup2", [call("dup-b", "ASK 1 DUP")]));
  const s = settings({ seed: 4, evalFraction: 0.3, dedup: "near" });
  const groups = splitGroups(turns);
  const context: BuildContext = {
    ...NO_CONTEXT,
    groups,
    forcedEval: forcedEvalGroups(groups, new Set()),
  };
  const whole = buildRows(turns, s, { ...NO_CONTEXT });

  const order = callOrder(turns);
  const firstRun = new DatasetRowBuilder(s, context);
  const stored = firstRun.add(order.slice(0, 40));
  const counts = firstRun.counts();

  const secondRun = new DatasetRowBuilder(s, context);
  secondRun.resume(stored, counts);
  const rest = secondRun.add(order.slice(40));

  assert.deepEqual([...stored, ...rest], whole.rows);
  assert.deepEqual(secondRun.counts(), { dropped: whole.dropped, redaction: whole.redaction });
});

const at = (iso: string) => new Date(`2026-11-10T${iso}:00.000Z`);
const timed = (
  spanId: string,
  ask: string,
  time: string,
  eventId = `e-${spanId}`,
): CandidateCall => ({ ...call(spanId, ask), eventId, capturedAt: at(time) });

test("interleaved turns: the earliest duplicate call by capture time stays, whatever the turns' end times", () => {
  // Turn A has the call at 09:00 and ends at 09:10; turn B has it at 09:05 and ends at 09:06.
  const a = turn("A", [timed("a-dup", "same ask", "09:00")]);
  const b = turn("B", [timed("b-dup", "same ask", "09:05")]);
  const result = buildRows([b, a], settings({ dedup: "exact" }), NO_CONTEXT);
  assert.deepEqual(spans(result.rows), ["a-dup"]);
  assert.deepEqual(result.dropped, { ...emptyDrops(), duplicate_exact: 1 });
});

test("interleaved calls: an order by each turn's first call is not enough; the global call order is", () => {
  // A: 09:00 (unique), 09:10 (dup). B: 09:05 (dup). B's 09:05 call is the earliest duplicate.
  const a = turn("A", [
    timed("a-first", "unique ask", "09:00"),
    timed("a-dup", "same ask", "09:10"),
  ]);
  const b = turn("B", [timed("b-dup", "same ask", "09:05")]);
  const result = buildRows([a, b], settings({ dedup: "exact" }), NO_CONTEXT);
  assert.deepEqual(spans(result.rows), ["a-first", "b-dup"]);
  assert.deepEqual(
    result.rows.map((row) => row.ordinal),
    [0, 1],
  );
});

test("two duplicate calls with the same capture time: the smaller event id stays, in any input order", () => {
  const first = () => turn("X", [timed("x", "same ask", "09:00", "e-2")]);
  const second = () => turn("Y", [timed("y", "same ask", "09:00", "e-1")]);
  assert.deepEqual(
    spans(buildRows([first(), second()], settings({ dedup: "exact" }), NO_CONTEXT).rows),
    ["y"],
  );
  assert.deepEqual(
    spans(buildRows([second(), first()], settings({ dedup: "exact" }), NO_CONTEXT).rows),
    ["y"],
  );
});
