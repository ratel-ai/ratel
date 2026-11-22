import assert from "node:assert/strict";
import { test } from "node:test";
import {
  byArm,
  type EvaluableSelection,
  followThrough,
  observeSelections,
  observeUnified,
  pickBaselineArm,
  rankOf,
  referenceTarget,
  resolveAttributionMode,
  revealedArmBias,
  targetFor,
} from "./ground-truth";

const at = new Date("2026-09-04T10:00:00Z");

function selection(
  overrides: Partial<EvaluableSelection> & { selectionId: string },
): EvaluableSelection {
  return {
    occurredAt: at,
    query: null,
    arms: [],
    invokedToolId: null,
    invokedRank: null,
    ...overrides,
  };
}

test("rankOf returns a 1-based position, or null when the arm missed", () => {
  assert.equal(rankOf(["a", "b", "c"], "a"), 1);
  assert.equal(rankOf(["a", "b", "c"], "c"), 3);
  assert.equal(rankOf(["a", "b", "c"], "d"), null);
  assert.equal(rankOf([], "a"), null);
});

test("referenceTarget takes the baseline arm's own first result", () => {
  const one = selection({
    selectionId: "s1",
    arms: [
      { arm: "ratel", role: "shadow", resultIds: ["x", "y"] },
      { arm: "legacy", role: "serving", resultIds: ["y", "z"] },
    ],
  });

  assert.equal(referenceTarget(one, "legacy"), "y");
  assert.equal(referenceTarget(one, "ratel"), "x");
  assert.equal(referenceTarget(one, "absent"), null);
});

test("targetFor returns null when the tier has no target for this search", () => {
  const noInvocation = selection({
    selectionId: "s1",
    arms: [{ arm: "legacy", role: "serving", resultIds: ["y"] }],
  });

  assert.equal(targetFor(noInvocation, "revealed", "legacy"), null);
  assert.equal(targetFor(noInvocation, "reference", "legacy"), "y");
});

test("observeSelections ranks every arm against the revealed target", () => {
  const selections = [
    selection({
      selectionId: "s1",
      invokedToolId: "delete_task_relationship",
      arms: [
        {
          arm: "ratel",
          role: "shadow",
          resultIds: ["unlink_pr_from_task", "delete_task_relationship", "remove_tag_from_task"],
        },
        {
          arm: "legacy",
          role: "serving",
          resultIds: ["delete_task_relationship"],
        },
      ],
    }),
  ];

  const observations = observeSelections(selections, "revealed", "legacy");
  assert.deepEqual(
    observations.map((o) => [o.arm, o.rank]),
    [
      ["ratel", 2],
      ["legacy", 1],
    ],
  );
});

test("observeSelections drops searches with no target rather than counting misses", () => {
  // Two searches, only one of which the agent followed up on. Counting the
  // other as a miss would report retrieval failure where there is no evidence.
  const selections = [
    selection({
      selectionId: "s1",
      invokedToolId: "create_task",
      arms: [{ arm: "ratel", role: "shadow", resultIds: ["create_task"] }],
    }),
    selection({
      selectionId: "s2",
      invokedToolId: null,
      arms: [{ arm: "ratel", role: "shadow", resultIds: ["list_tasks"] }],
    }),
  ];

  const observations = observeSelections(selections, "revealed", "legacy");
  assert.equal(observations.length, 1);
  assert.equal(observations[0].selectionId, "s1");
});

test("observeSelections records a miss when the arm returned the wrong tools", () => {
  const observations = observeSelections(
    [
      selection({
        selectionId: "s1",
        invokedToolId: "search_tasks",
        arms: [
          {
            arm: "ratel",
            role: "shadow",
            resultIds: ["search_tasks_by_time", "list_stale_tasks"],
          },
        ],
      }),
    ],
    "revealed",
    "legacy",
  );

  assert.deepEqual(observations, [{ arm: "ratel", selectionId: "s1", rank: null }]);
});

test("the reference tier never scores the baseline against itself", () => {
  const observations = observeSelections(
    [
      selection({
        selectionId: "s1",
        arms: [
          { arm: "ratel", role: "shadow", resultIds: ["b", "a"] },
          { arm: "legacy", role: "serving", resultIds: ["a", "c"] },
        ],
      }),
    ],
    "reference",
    "legacy",
  );

  assert.deepEqual(observations, [{ arm: "ratel", selectionId: "s1", rank: 2 }]);
});

test("byArm groups observations and keeps first-seen order", () => {
  const grouped = byArm([
    { arm: "ratel", selectionId: "s1", rank: 1 },
    { arm: "legacy", selectionId: "s1", rank: 2 },
    { arm: "ratel", selectionId: "s2", rank: null },
  ]);

  assert.deepEqual([...grouped.keys()], ["ratel", "legacy"]);
  assert.equal(grouped.get("ratel")!.length, 2);
});

test("revealedArmBias flags a serving arm as self-selected", () => {
  const selections = [
    selection({
      selectionId: "s1",
      invokedToolId: "a",
      arms: [
        { arm: "ratel", role: "shadow", resultIds: ["a"] },
        { arm: "legacy", role: "serving", resultIds: ["a"] },
      ],
    }),
  ];

  assert.equal(revealedArmBias(selections, "legacy"), "self-selected");
  assert.equal(revealedArmBias(selections, "ratel"), "independent");
});

test("revealedArmBias reports mixed when an arm both served and shadowed", () => {
  const selections = [
    selection({
      selectionId: "s1",
      invokedToolId: "a",
      arms: [{ arm: "ratel", role: "serving", resultIds: ["a"] }],
    }),
    selection({
      selectionId: "s2",
      invokedToolId: "b",
      arms: [{ arm: "ratel", role: "shadow", resultIds: ["b"] }],
    }),
  ];

  assert.equal(revealedArmBias(selections, "ratel"), "mixed");
});

test("revealedArmBias ignores searches the agent never followed up on", () => {
  const selections = [
    selection({
      selectionId: "s1",
      invokedToolId: null,
      arms: [{ arm: "ratel", role: "serving", resultIds: ["a"] }],
    }),
  ];

  assert.equal(revealedArmBias(selections, "ratel"), "independent");
});

test("pickBaselineArm names the incumbent even when it is the shadow", () => {
  // Acme's real production shape: Ratel SERVES their developer units and
  // their legacy search runs in shadow behind it. Ranking by serving count
  // would nominate ratel as the baseline and label our own arm "yours" in the
  // partner's report.
  const selections = [
    selection({
      selectionId: "s1",
      arms: [
        { arm: "ratel", role: "serving", resultIds: [] },
        { arm: "legacy", role: "shadow", resultIds: [] },
      ],
    }),
    selection({
      selectionId: "s2",
      arms: [
        { arm: "ratel", role: "serving", resultIds: [] },
        { arm: "legacy", role: "shadow", resultIds: [] },
      ],
    }),
  ];

  assert.equal(pickBaselineArm(selections), "legacy");
});

test("pickBaselineArm still picks the incumbent when it is the one serving", () => {
  const selections = [
    selection({
      selectionId: "s1",
      arms: [
        { arm: "ratel", role: "shadow", resultIds: [] },
        { arm: "legacy", role: "serving", resultIds: [] },
      ],
    }),
  ];

  assert.equal(pickBaselineArm(selections), "legacy");
});

test("pickBaselineArm reads 'a' as a whole name, not a letter inside one", () => {
  // An arm literally called "a" is an incumbent. An arm that merely contains
  // the letter is not: a substring test here nominates "ratel".
  const named = [
    selection({
      selectionId: "s1",
      arms: [
        { arm: "ratel", role: "serving", resultIds: [] },
        { arm: "a", role: "shadow", resultIds: [] },
      ],
    }),
  ];
  assert.equal(pickBaselineArm(named), "a");

  // Neither name claims to be the incumbent, so the serving arm wins on its
  // own merits rather than on a stray letter.
  const unnamed = [
    selection({
      selectionId: "s1",
      arms: [
        { arm: "ratel", role: "shadow", resultIds: [] },
        { arm: "vendor-search", role: "serving", resultIds: [] },
      ],
    }),
  ];
  assert.equal(pickBaselineArm(unnamed), "vendor-search");
});

test("pickBaselineArm honours a bare A/B naming", () => {
  const selections = [
    selection({
      selectionId: "s1",
      arms: [
        { arm: "b", role: "shadow", resultIds: [] },
        { arm: "a", role: "shadow", resultIds: [] },
      ],
    }),
  ];

  assert.equal(pickBaselineArm(selections), "a");
});

test("pickBaselineArm falls back to serving count when no name claims it", () => {
  const selections = [
    selection({
      selectionId: "s1",
      arms: [
        { arm: "zeta", role: "serving", resultIds: [] },
        { arm: "beta", role: "shadow", resultIds: [] },
      ],
    }),
  ];

  assert.equal(pickBaselineArm(selections), "zeta");
});

test("pickBaselineArm falls back to alphabetical, and refuses an empty set", () => {
  const nameless = [
    selection({
      selectionId: "s1",
      arms: [
        { arm: "zeta", role: null, resultIds: [] },
        { arm: "beta", role: null, resultIds: [] },
      ],
    }),
  ];
  assert.equal(pickBaselineArm(nameless), "beta");
  assert.equal(pickBaselineArm([]), null);
});

test("resolveAttributionMode prefers a tool id, falls back to a recorded rank", () => {
  assert.equal(resolveAttributionMode({ toolIds: 5, recordedRanks: 40 }), "tool-id");
  assert.equal(resolveAttributionMode({ toolIds: 0, recordedRanks: 40 }), "recorded-rank");
  // Acme's production shape today: comparisons and results, no invocation
  // records at all, so there is no revealed evidence to score.
  assert.equal(resolveAttributionMode({ toolIds: 0, recordedRanks: 0 }), "none");
});

test("recorded-rank mode scores only the arm that served, from its recorded position", () => {
  const selections = [
    selection({
      selectionId: "s1",
      invokedRank: { arm: "legacy", rank: 1 },
      arms: [
        { arm: "ratel", role: "shadow", resultIds: ["a", "b"] },
        { arm: "legacy", role: "serving", resultIds: ["b"] },
      ],
    }),
    selection({
      selectionId: "s2",
      invokedRank: { arm: "legacy", rank: null },
      arms: [
        { arm: "ratel", role: "shadow", resultIds: ["a"] },
        { arm: "legacy", role: "serving", resultIds: ["c"] },
      ],
    }),
  ];

  assert.deepEqual(observeSelections(selections, "revealed", "legacy", "recorded-rank"), [
    { arm: "legacy", selectionId: "s1", rank: 1 },
    // Wire rank -1: the agent ran something the serving arm never returned,
    // which is a scored miss rather than a dropped row.
    { arm: "legacy", selectionId: "s2", rank: null },
  ]);
});

test("recorded-rank mode ignores selections with no recorded invocation", () => {
  assert.deepEqual(
    observeSelections(
      [
        selection({
          selectionId: "s1",
          arms: [{ arm: "legacy", role: "serving", resultIds: ["a"] }],
        }),
      ],
      "revealed",
      "legacy",
      "recorded-rank",
    ),
    [],
  );
});

test("recorded-rank mode leaves the reference tier untouched", () => {
  assert.deepEqual(
    observeSelections(
      [
        selection({
          selectionId: "s1",
          invokedRank: { arm: "legacy", rank: 1 },
          arms: [
            { arm: "ratel", role: "shadow", resultIds: ["b", "a"] },
            { arm: "legacy", role: "serving", resultIds: ["a"] },
          ],
        }),
      ],
      "reference",
      "legacy",
      "recorded-rank",
    ),
    [{ arm: "ratel", selectionId: "s1", rank: 2 }],
  );
});

test("none mode yields no revealed observations at all", () => {
  assert.deepEqual(
    observeSelections(
      [
        selection({
          selectionId: "s1",
          invokedRank: { arm: "legacy", rank: 1 },
          invokedToolId: "a",
          arms: [{ arm: "legacy", role: "serving", resultIds: ["a"] }],
        }),
      ],
      "revealed",
      "legacy",
      "none",
    ),
    [],
  );
});

test("observeUnified picks the best evidence per search, not per window", () => {
  // One search the agent acted on, one it did not. A window-level mode either
  // discards the strong evidence or discards the dense evidence; this keeps both.
  // Ratel shadows here, so the revealed evidence is a fair test of it.
  const selections = [
    selection({
      selectionId: "s1",
      invokedToolId: "filter_tasks",
      arms: [
        { arm: "legacy", role: "serving", resultIds: ["filter_tasks"] },
        { arm: "ratel", role: "shadow", resultIds: ["count_tasks", "filter_tasks"] },
      ],
    }),
    selection({
      selectionId: "s2",
      judgedToolId: "b",
      arms: [
        { arm: "legacy", role: "serving", resultIds: ["a", "b"] },
        { arm: "ratel", role: "shadow", resultIds: ["a"] },
      ],
    }),
  ];

  const byArm = observeUnified(selections, "legacy");
  const ratel = byArm.get("ratel")!;

  assert.equal(ratel.length, 2);
  assert.equal(ratel[0].evidence, "revealed");
  assert.equal(ratel[1].evidence, "judged");
  // Found at rank 2 of its own list, so rank-weighted credit but full reach.
  assert.ok(Math.abs(ratel[0].credit - (0.5 + 0.5 / Math.log2(3))) < 1e-9);
  assert.equal(ratel[0].reach, 1);
  // The answer key named "b" and ratel never returned it: a scored miss, even
  // though ratel reproduced legacy's first result.
  assert.equal(ratel[1].credit, 0);
  assert.equal(ratel[1].reach, 0);
  assert.equal(ratel[1].contained, false);
});

test("observeUnified refuses to score the serving arm on what the agent ran", () => {
  // Survivorship: the agent can only invoke a tool it was shown, so the tool it
  // ran is in the serving arm's list by construction. Scoring that arm against
  // it restates the setup and hands whichever arm is serving a free 100%.
  const byArm = observeUnified(
    [
      selection({
        selectionId: "s1",
        invokedToolId: "a",
        judgedToolId: "c",
        arms: [
          { arm: "ratel", role: "serving", resultIds: ["a", "c"] },
          { arm: "legacy", role: "shadow", resultIds: ["b", "a"] },
        ],
      }),
    ],
    "legacy",
  );

  // The shadow arm had no influence on the choice, so it is fairly tested.
  const legacy = byArm.get("legacy")!;
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].evidence, "revealed");
  assert.equal(legacy[0].contained, true);

  // The serving arm falls back to the answer key rather than banking a
  // guaranteed hit.
  const ratel = byArm.get("ratel")!;
  assert.equal(ratel.length, 1);
  assert.equal(ratel[0].evidence, "judged");
  assert.equal(ratel[0].contained, true);
});

test("observeUnified leaves the serving arm out when there is no answer key", () => {
  const byArm = observeUnified(
    [
      selection({
        selectionId: "s1",
        invokedToolId: "a",
        arms: [
          { arm: "ratel", role: "serving", resultIds: ["a"] },
          { arm: "legacy", role: "shadow", resultIds: ["b", "a"] },
        ],
      }),
    ],
    "legacy",
  );

  assert.equal(byArm.get("ratel"), undefined);
  assert.equal(byArm.get("legacy")!.length, 1);
});

test("followThrough counts the searches the agent abandoned, per serving arm", () => {
  // The bias no choice of evidence can close: we only score searches the agent
  // acted on, and whether it acted depends on how good the served list was. A
  // serving arm that returns junk has its failures deleted, not counted.
  const rates = followThrough([
    selection({
      selectionId: "s1",
      invokedToolId: "a",
      arms: [{ arm: "ratel", role: "serving", resultIds: ["a"] }],
    }),
    selection({
      selectionId: "s2",
      arms: [{ arm: "ratel", role: "serving", resultIds: ["junk"] }],
    }),
    selection({
      selectionId: "s3",
      arms: [{ arm: "ratel", role: "serving", resultIds: ["junk"] }],
    }),
    selection({
      selectionId: "s4",
      invokedToolId: "b",
      arms: [{ arm: "legacy", role: "serving", resultIds: ["b"] }],
    }),
  ]);

  assert.equal(rates.measurable, true);
  assert.deepEqual(rates.arms, [
    { arm: "legacy", served: 1, followed: 1, rate: 1 },
    { arm: "ratel", served: 3, followed: 1, rate: 1 / 3 },
  ]);
});

test("followThrough refuses to call an uninstrumented window 0% abandonment", () => {
  // Exactly the state Acme production is in: comparisons and results, no
  // invocation records anywhere. Every arm would otherwise score 0%, which
  // reads as "every agent gave up on every search" when nobody is reporting.
  const rates = followThrough([
    selection({
      selectionId: "s1",
      arms: [{ arm: "ratel", role: "serving", resultIds: ["a"] }],
    }),
    selection({
      selectionId: "s2",
      arms: [{ arm: "ratel", role: "serving", resultIds: ["b"] }],
    }),
  ]);

  assert.equal(rates.measurable, false);
  assert.equal(rates.arms[0].rate, null);
  assert.equal(rates.arms[0].served, 2);
});

test("followThrough counts a recorded rank as follow-through too", () => {
  const rates = followThrough([
    selection({
      selectionId: "s1",
      invokedRank: { arm: "ratel", rank: 2 },
      arms: [{ arm: "ratel", role: "serving", resultIds: ["a", "b"] }],
    }),
  ]);

  assert.equal(rates.arms[0].followed, 1);
  assert.equal(rates.measurable, true);
});

test("observeUnified never falls back to the baseline's list", () => {
  // No invocation and no answer key. The old fallback scored ratel on how much
  // of legacy's list it reproduced, which assumed legacy was right. Now the
  // search carries no evidence for any arm and leaves the population.
  const byArm = observeUnified(
    [
      selection({
        selectionId: "s1",
        arms: [
          { arm: "legacy", role: "serving", resultIds: ["a", "b"] },
          { arm: "ratel", role: "shadow", resultIds: ["a", "b"] },
        ],
      }),
      selection({
        selectionId: "s2",
        unclear: true,
        arms: [
          { arm: "legacy", role: "serving", resultIds: ["a"] },
          { arm: "ratel", role: "shadow", resultIds: ["a"] },
        ],
      }),
    ],
    "legacy",
  );

  assert.equal(byArm.size, 0);
});

test("observeUnified scores the baseline against the answer key like any arm", () => {
  const byArm = observeUnified(
    [
      selection({
        selectionId: "s1",
        judgedToolId: "b",
        arms: [
          { arm: "legacy", role: "serving", resultIds: ["a"] },
          { arm: "ratel", role: "shadow", resultIds: ["b"] },
        ],
      }),
    ],
    "legacy",
  );

  const legacy = byArm.get("legacy")!;
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].evidence, "judged");
  assert.equal(legacy[0].contained, false);
  assert.equal(byArm.get("ratel")![0].credit, 1);
});

test("observeSelections under the answer key scores the baseline and skips unanswered searches", () => {
  const observations = observeSelections(
    [
      selection({
        selectionId: "answered",
        judgedToolId: "t",
        arms: [
          { arm: "legacy", role: "serving", resultIds: ["x", "t"] },
          { arm: "ratel", role: "shadow", resultIds: ["t"] },
        ],
      }),
      selection({
        selectionId: "unread",
        arms: [
          { arm: "legacy", role: "serving", resultIds: ["t"] },
          { arm: "ratel", role: "shadow", resultIds: ["t"] },
        ],
      }),
      selection({
        selectionId: "unclear",
        unclear: true,
        judgedToolId: null,
        arms: [
          { arm: "legacy", role: "serving", resultIds: ["t"] },
          { arm: "ratel", role: "shadow", resultIds: ["t"] },
        ],
      }),
    ],
    "judged",
    "legacy",
  );

  // Unlike the reference tier, the baseline IS scored: the answer was chosen
  // independently of both arms. The unread and unclear searches leave entirely.
  assert.deepEqual(observations, [
    { arm: "legacy", selectionId: "answered", rank: 2 },
    { arm: "ratel", selectionId: "answered", rank: 1 },
  ]);
});

test("targetFor reads the answer key under the judged tier", () => {
  const answered = selection({
    selectionId: "s1",
    invokedToolId: "ran",
    judgedToolId: "key",
    arms: [{ arm: "legacy", role: "serving", resultIds: ["first"] }],
  });
  assert.equal(targetFor(answered, "judged", "legacy"), "key");
  assert.equal(targetFor(answered, "revealed", "legacy"), "ran");
  assert.equal(targetFor(selection({ selectionId: "s2" }), "judged", "legacy"), null);
});

test("observeUnified skips a search where neither evidence exists", () => {
  const byArm = observeUnified(
    [
      selection({
        selectionId: "s1",
        arms: [
          { arm: "legacy", role: "serving", resultIds: [] },
          { arm: "ratel", role: "shadow", resultIds: ["a"] },
        ],
      }),
    ],
    "legacy",
  );

  assert.equal(byArm.size, 0);
});

test("an answer the agent was seen running never grades the arm that served it", () => {
  const selections = [
    selection({
      selectionId: "s1",
      judgedToolId: "picked",
      judgedFrom: "invoked",
      arms: [
        { arm: "ratel", role: "serving", resultIds: ["picked"] },
        { arm: "legacy", role: "shadow", resultIds: ["other", "picked"] },
      ],
    }),
    selection({
      selectionId: "s2",
      judgedToolId: "decided",
      judgedFrom: "judge",
      arms: [
        { arm: "ratel", role: "serving", resultIds: ["decided"] },
        { arm: "legacy", role: "shadow", resultIds: ["other"] },
      ],
    }),
  ];
  const unified = observeUnified(selections, "legacy");
  // The serving arm is scored only on the independent (judged) answer.
  assert.equal(unified.get("ratel")?.length, 1);
  assert.equal(unified.get("legacy")?.length, 2);
  // The head-to-head tier drops the invoked-answer search for BOTH arms, so
  // the arms stay on one population.
  const judged = observeSelections(selections, "judged", "legacy");
  assert.deepEqual(judged.map((row) => `${row.arm}:${row.selectionId}`).sort(), [
    "legacy:s2",
    "ratel:s2",
  ]);
});
