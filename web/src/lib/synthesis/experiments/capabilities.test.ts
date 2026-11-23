import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCapabilities } from "./capabilities";
import type { ArmSearchSpan, CapabilityHit } from "./types";

test("compareCapabilities falls back to reported hit counts when rankings are absent", () => {
  const spans: ArmSearchSpan[] = [
    searchSpan("control", "c1", 4),
    searchSpan("control", "c2", 3),
    searchSpan("treatment", "t1", 7),
  ];

  assert.deepEqual(compareCapabilities("control", ["control", "treatment"], spans), {
    hasRankings: false,
    rows: [],
    reportedHitMetrics: [
      {
        arm: "control",
        total: 7,
        searchSpanCount: 2,
        averagePerSearch: 3.5,
      },
      {
        arm: "treatment",
        total: 7,
        searchSpanCount: 1,
        averagePerSearch: 7,
      },
    ],
  });
});

test("compareCapabilities does not treat partial ranking hydration as absence", () => {
  const spans: ArmSearchSpan[] = [
    searchSpan("control", "c1", 2, [hit("tool", "alpha", 0), hit("tool", "beta", 1)]),
    searchSpan("variant", "v1", 2, [hit("tool", "alpha", 0)]),
  ];

  assert.deepEqual(compareCapabilities("control", ["control", "variant"], spans), {
    hasRankings: false,
    rows: [],
    reportedHitMetrics: [
      {
        arm: "control",
        total: 2,
        searchSpanCount: 1,
        averagePerSearch: 2,
      },
      {
        arm: "variant",
        total: 2,
        searchSpanCount: 1,
        averagePerSearch: 2,
      },
    ],
  });
});

test("compareCapabilities keeps unknown reported hit counts conservative", () => {
  const spans: ArmSearchSpan[] = [
    searchSpan("control", "c1", 1, [hit("tool", "alpha", 0)]),
    searchSpan("variant", "v1", null),
  ];

  assert.deepEqual(compareCapabilities("control", ["control", "variant"], spans), {
    hasRankings: false,
    rows: [],
    reportedHitMetrics: [
      {
        arm: "control",
        total: 1,
        searchSpanCount: 1,
        averagePerSearch: 1,
      },
      {
        arm: "variant",
        total: null,
        searchSpanCount: 1,
        averagePerSearch: null,
      },
    ],
  });
});

test("compareCapabilities requires ranking data for every requested arm", () => {
  const spans: ArmSearchSpan[] = [searchSpan("control", "c1", 1, [hit("tool", "alpha", 0)])];

  assert.deepEqual(compareCapabilities("control", ["control", "variant"], spans), {
    hasRankings: false,
    rows: [],
    reportedHitMetrics: [
      {
        arm: "control",
        total: 1,
        searchSpanCount: 1,
        averagePerSearch: 1,
      },
      {
        arm: "variant",
        total: 0,
        searchSpanCount: 0,
        averagePerSearch: null,
      },
    ],
  });
});

test("compareCapabilities counts duplicate search-span rows once", () => {
  const duplicate = searchSpan("control", "c1", 1, [hit("tool", "alpha", 0)]);

  assert.deepEqual(
    compareCapabilities(
      "control",
      ["control"],
      [
        duplicate,
        {
          ...duplicate,
          hits: [...duplicate.hits],
        },
      ],
    ),
    {
      hasRankings: true,
      rows: [
        {
          type: "tool",
          id: "alpha",
          baselineAppearances: 1,
          baselineAverageRank: 0,
          arms: [
            {
              arm: "control",
              appearances: 1,
              averageRank: 0,
              rankDelta: 0,
              absent: false,
            },
          ],
          maxAbsoluteRankDelta: null,
        },
      ],
      reportedHitMetrics: [
        {
          arm: "control",
          total: 1,
          searchSpanCount: 1,
          averagePerSearch: 1,
        },
      ],
    },
  );
});

test("compareCapabilities counts a repeated capability at its best rank per span", () => {
  const spans = [
    searchSpan("control", "c1", 2, [hit("tool", "alpha", 3), hit("tool", "alpha", 1)]),
  ];

  assert.deepEqual(compareCapabilities("control", ["control"], spans), {
    hasRankings: true,
    rows: [
      {
        type: "tool",
        id: "alpha",
        baselineAppearances: 1,
        baselineAverageRank: 1,
        arms: [
          {
            arm: "control",
            appearances: 1,
            averageRank: 1,
            rankDelta: 0,
            absent: false,
          },
        ],
        maxAbsoluteRankDelta: null,
      },
    ],
    reportedHitMetrics: [
      {
        arm: "control",
        total: 2,
        searchSpanCount: 1,
        averagePerSearch: 2,
      },
    ],
  });
});

test("compareCapabilities averages 0-based ranks across the stable capability union", () => {
  const spans: ArmSearchSpan[] = [
    searchSpan("control", "c1", 4, [
      hit("tool", "alpha", 0),
      hit("skill", "review", 3),
      hit("tool", "control-only", 1),
      hit("skill", "tie", 0),
    ]),
    searchSpan("control", "c2", 3, [
      hit("tool", "alpha", 2),
      hit("skill", "review", 1),
      hit("skill", "tie", 2),
    ]),
    searchSpan("variant", "v1", 4, [
      hit("tool", "alpha", 3),
      hit("skill", "review", 0),
      hit("tool", "variant-only", 1),
      hit("skill", "tie", 1),
    ]),
    searchSpan("variant", "v2", 3, [
      hit("tool", "alpha", 1),
      hit("skill", "review", 0),
      hit("skill", "tie", 3),
    ]),
  ];

  assert.deepEqual(compareCapabilities("control", ["control", "variant"], spans), {
    hasRankings: true,
    rows: [
      {
        type: "skill",
        id: "review",
        baselineAppearances: 2,
        baselineAverageRank: 2,
        arms: [
          {
            arm: "control",
            appearances: 2,
            averageRank: 2,
            rankDelta: 0,
            absent: false,
          },
          {
            arm: "variant",
            appearances: 2,
            averageRank: 0,
            rankDelta: -2,
            absent: false,
          },
        ],
        maxAbsoluteRankDelta: 2,
      },
      {
        type: "skill",
        id: "tie",
        baselineAppearances: 2,
        baselineAverageRank: 1,
        arms: [
          {
            arm: "control",
            appearances: 2,
            averageRank: 1,
            rankDelta: 0,
            absent: false,
          },
          {
            arm: "variant",
            appearances: 2,
            averageRank: 2,
            rankDelta: 1,
            absent: false,
          },
        ],
        maxAbsoluteRankDelta: 1,
      },
      {
        type: "tool",
        id: "alpha",
        baselineAppearances: 2,
        baselineAverageRank: 1,
        arms: [
          {
            arm: "control",
            appearances: 2,
            averageRank: 1,
            rankDelta: 0,
            absent: false,
          },
          {
            arm: "variant",
            appearances: 2,
            averageRank: 2,
            rankDelta: 1,
            absent: false,
          },
        ],
        maxAbsoluteRankDelta: 1,
      },
      {
        type: "tool",
        id: "control-only",
        baselineAppearances: 1,
        baselineAverageRank: 1,
        arms: [
          {
            arm: "control",
            appearances: 1,
            averageRank: 1,
            rankDelta: 0,
            absent: false,
          },
          {
            arm: "variant",
            appearances: 0,
            averageRank: null,
            rankDelta: null,
            absent: true,
          },
        ],
        maxAbsoluteRankDelta: null,
      },
      {
        type: "tool",
        id: "variant-only",
        baselineAppearances: 0,
        baselineAverageRank: null,
        arms: [
          {
            arm: "control",
            appearances: 0,
            averageRank: null,
            rankDelta: null,
            absent: true,
          },
          {
            arm: "variant",
            appearances: 1,
            averageRank: 1,
            rankDelta: null,
            absent: false,
          },
        ],
        maxAbsoluteRankDelta: null,
      },
    ],
    reportedHitMetrics: [
      {
        arm: "control",
        total: 7,
        searchSpanCount: 2,
        averagePerSearch: 3.5,
      },
      {
        arm: "variant",
        total: 7,
        searchSpanCount: 2,
        averagePerSearch: 3.5,
      },
    ],
  });
});

function searchSpan(
  arm: string,
  spanId: string,
  reportedHitCount: number | null,
  hits: CapabilityHit[] = [],
): ArmSearchSpan {
  return {
    arm,
    traceId: `trace-${spanId}`,
    spanId,
    reportedHitCount,
    hits,
  };
}

function hit(type: CapabilityHit["type"], id: string, rank: number): CapabilityHit {
  return { type, id, rank, score: null };
}
