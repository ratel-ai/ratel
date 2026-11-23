import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluableSelection } from "@/lib/synthesis/quality/ground-truth";
import {
  buildHeadline,
  headlineNote,
  headlineValue,
  MIN_SHARE_SAMPLE,
  onTier,
  pickTier,
  shareTrend,
  type TierObservation,
  type TierSets,
  tierObservations,
  trendBuckets,
} from "./headline";

const DAY = 86_400_000;
const END = new Date("2026-10-15T00:00:00.000Z");
const WEEK = { since: new Date(END.getTime() - 7 * DAY), until: END };

function selection(
  overrides: Partial<EvaluableSelection> & { ourRole?: "serving" | "shadow" } = {},
): EvaluableSelection {
  const { ourRole = "serving", ...rest } = overrides;
  return {
    selectionId: "s",
    occurredAt: new Date(END.getTime() - DAY / 2),
    query: "deploy to staging",
    arms: [
      { arm: "ratel", role: ourRole, resultIds: ["flaky_deploy", "vercel_promote"] },
      {
        arm: "legacy",
        role: ourRole === "serving" ? "shadow" : "serving",
        resultIds: ["vercel_promote"],
      },
    ],
    invokedToolId: null,
    invokedRank: null,
    ...rest,
  };
}

test("each tier keeps only its own evidence, and never a tool picked from our own list", () => {
  const sets = tierObservations(
    [
      selection({ judgedToolId: "vercel_promote", judgedFrom: "judge" }),
      selection({ judgedToolId: "vercel_promote", judgedFrom: "invoked" }),
      selection({ invokedToolId: "vercel_promote" }),
      selection({ ourRole: "shadow", invokedToolId: "vercel_promote" }),
      selection({ ourRole: "shadow", judgedToolId: "flaky_deploy", judgedFrom: "invoked" }),
      selection({ unclear: true }),
    ],
    "ratel",
  );
  assert.deepEqual(
    sets.judged.map((observation) => observation.rank),
    [2],
    "only the answer key's own verdict is Judged",
  );
  assert.deepEqual(
    sets.seen.map((observation) => observation.rank),
    [2, 1],
    "seen it run counts only where our list was not the one served",
  );
});

test("the demo's case: every answer was run from our own list, so there is no tier and no number", () => {
  const ourOwn = Array.from({ length: 50 }, () =>
    selection({ judgedToolId: "vercel_promote", judgedFrom: "invoked" }),
  );
  const sets = tierObservations(ourOwn, "ratel");
  assert.equal(pickTier(sets), null);
  const headline = buildHeadline(sets, { judged: [], seen: [] }, WEEK);
  assert.equal(headline.tier, null);
  assert.equal(headline.share, null);
  assert.equal(headlineValue(headline), "Not measured yet");
  assert.equal(
    headlineNote(headline, { kind: "telemetry" }, "the last 7 days"),
    "No judged searches in the last 7 days. Analyse searches to judge them.",
  );
});

function observations(count: number, firsts: number, daysAgo = 1): TierObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    occurredAt: new Date(END.getTime() - daysAgo * DAY + 1000),
    rank: index < firsts ? 1 : 2,
  }));
}

function sets(judged: TierObservation[], seen: TierObservation[] = []): TierSets {
  return { judged, seen };
}

test("Judged leads whenever it has a search; Seen it run only without one", () => {
  assert.equal(pickTier(sets(observations(1, 1), observations(40, 30))), "judged");
  assert.equal(pickTier(sets([], observations(40, 30))), "seen");
  const seen = buildHeadline(sets([], observations(40, 30)), sets([]), WEEK);
  assert.equal(seen.tier, "seen");
  assert.equal(seen.share, 0.75);
});

test("below ten searches the share is withheld and the count is said", () => {
  const thin = buildHeadline(sets(observations(MIN_SHARE_SAMPLE - 1, 9)), sets([]), WEEK);
  assert.equal(thin.share, null);
  assert.equal(thin.n, 9);
  assert.equal(headlineValue(thin), "Not enough searches yet");
  assert.equal(
    headlineNote(thin, { kind: "telemetry" }, "the last 7 days"),
    "Judged: 9 searches in the last 7 days, 10 needed",
  );
  const enough = buildHeadline(sets(observations(MIN_SHARE_SAMPLE, 7)), sets([]), WEEK);
  assert.equal(enough.share, 0.7);
  assert.equal(headlineValue(enough), null);
  assert.equal(
    headlineNote(enough, { kind: "telemetry" }, "the last 7 days"),
    "Judged on 10 searches your agent made",
  );
  assert.equal(
    headlineNote(
      enough,
      { kind: "experiment", name: "reranker-shadow", variant: "shadow" },
      "the last 7 days",
    ),
    "Judged on 10 searches in reranker-shadow, variant shadow",
  );
});

test("a change is shown only for the same tier, both sides at ten, and intervals apart", () => {
  const now = sets(observations(40, 36));
  const clear = buildHeadline(now, sets(observations(40, 12, 8)), WEEK);
  assert.deepEqual(clear.change, { direction: "up", text: "+60 pts" });
  assert.equal(
    buildHeadline(now, sets(observations(40, 33, 8)), WEEK).change,
    null,
    "within the noise",
  );
  assert.equal(
    buildHeadline(now, sets(observations(9, 0, 8)), WEEK).change,
    null,
    "too few before",
  );
  assert.equal(
    buildHeadline(now, sets([], observations(40, 0, 8)), WEEK).change,
    null,
    "another tier never compares",
  );
  assert.equal(
    buildHeadline(now, sets(observations(40, 12, 8)), WEEK, false).change,
    null,
    "a cut read compares nothing",
  );
});

test("the trend is days up to a month, weeks beyond; thin buckets are gaps, a 0% day is a 0", () => {
  const week = trendBuckets(WEEK);
  assert.equal(week.length, 7);
  assert.equal(week.at(-1)!.until.toISOString(), END.toISOString());
  const quarter = trendBuckets({ since: new Date(END.getTime() - 90 * DAY), until: END });
  assert.equal(quarter.length, 13);
  assert.equal(
    quarter[0]!.since.getTime(),
    END.getTime() - 90 * DAY,
    "the oldest bucket is clipped to the window",
  );
  const trend = shareTrend(
    [...observations(3, 2, 1), ...observations(3, 0, 2), ...observations(2, 2, 3)],
    week,
  );
  assert.equal(trend.at(-1), 2 / 3);
  assert.equal(trend.at(-2), 0, "three searches, none first: a real 0");
  assert.equal(trend.at(-3), null, "two searches: too thin, a gap");
  assert.equal(buildHeadline(sets(observations(12, 6)), sets([]), WEEK).trendUnit, "day");
  assert.equal(
    buildHeadline(sets(observations(12, 6)), sets([]), {
      since: new Date(END.getTime() - 90 * DAY),
      until: END,
    }).trendUnit,
    "week",
  );
});

test("found counts the right tool anywhere in the list, on the same tier and searches as first", () => {
  const at = (hours: number) => new Date(END.getTime() - hours * 3_600_000);
  const ranks = [1, 1, 2, 3, null, 1, 2, null, 1, 4, 1, null];
  const current: TierSets = {
    judged: ranks.map((rank, index) => ({ occurredAt: at(index + 1), rank })),
    seen: [],
  };
  const empty: TierSets = { judged: [], seen: [] };
  const first = buildHeadline(current, empty, WEEK);
  const found = buildHeadline(current, empty, WEEK, true, "found");
  assert.equal(first.hits, 5);
  assert.equal(found.hits, 9);
  assert.equal(found.n, first.n, "one population for both numbers");
  assert.equal(found.share, 9 / 12);
  assert.equal(found.tier, "judged");
  assert.deepEqual(
    shareTrend(
      [
        { occurredAt: at(1), rank: 2 },
        { occurredAt: at(2), rank: null },
        { occurredAt: at(3), rank: 1 },
      ],
      trendBuckets(WEEK),
      3,
      "found",
    ).at(-1),
    2 / 3,
  );
});

test("another arm is read on our tier only, or not at all", () => {
  const sets: TierSets = {
    judged: [{ occurredAt: END, rank: 1 }],
    seen: [{ occurredAt: END, rank: 2 }],
  };
  assert.deepEqual(onTier(sets, "judged"), { judged: sets.judged, seen: [] });
  assert.deepEqual(onTier(sets, "seen"), { judged: [], seen: sets.seen });
  assert.equal(
    onTier({ judged: [], seen: sets.seen }, "judged"),
    null,
    "nothing on our tier, no comparison",
  );
  assert.equal(onTier(sets, null), null);
});
