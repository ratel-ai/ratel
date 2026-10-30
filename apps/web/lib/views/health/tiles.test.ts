import assert from "node:assert/strict";
import { test } from "node:test";
import { gapSegments } from "@/lib/platform/chart";
import { wilsonInterval } from "@/lib/readings/stats";
import {
  type HealthTile,
  TURN_SHAPE_KINDS,
  type TurnShapeView,
} from "@/lib/readings/trace-signals/view";
import { MOCK_COLLECTING, MOCK_HEALTH_MODEL } from "@/lib/views/health/mock-fixture";
import {
  formatSharePercent,
  formatTurnCount,
  roundIntervalOutward,
  SHAPE_MARKS,
  SHAPE_PICTURE_LABEL,
  sortShapes,
  sparkDomain,
  TILE_PLACEHOLDER,
  tierGlyphLabel,
  tileDelta,
  tileFigure,
  tileIntervalText,
  trendText,
} from "@/lib/views/health/tiles";

const TWO_DECIMALS = /\d\.\d{2}/;

function tile(overrides: Partial<HealthTile> = {}): HealthTile {
  return { ...MOCK_HEALTH_MODEL.tiles[0], ...overrides };
}

test("a share reads as a whole percent and a rate with one decimal", () => {
  assert.deepEqual(tileFigure(tile({ value: 0.642 })), { value: "64%", unit: null, ready: true });
  assert.deepEqual(tileFigure(tile({ value: 9.44, unit: "per_100_turns" })), {
    value: "9.4",
    unit: "per 100 turns",
    ready: true,
  });
  assert.equal(tileFigure(tile({ value: 10, unit: "per_100_turns" })).value, "10.0");
  assert.equal(formatSharePercent(0.004), "<1%");
  assert.equal(formatSharePercent(0), "0%");
  assert.equal(formatSharePercent(1), "100%");
});

test("a collecting tile prints the placeholder and nothing else", () => {
  const collecting = tile({ value: null, interval: { low: 0.1, high: 0.2 }, delta: 0.05 });
  assert.equal(TILE_PLACEHOLDER, "–");
  assert.deepEqual(tileFigure(collecting), { value: TILE_PLACEHOLDER, unit: null, ready: false });
  assert.equal(tileIntervalText(collecting), null, "no interval without a figure");
  assert.equal(tileDelta(collecting), null, "no chip without a figure");
  for (const each of MOCK_COLLECTING.tiles) {
    assert.equal(tileFigure(each).value, TILE_PLACEHOLDER);
  }
});

test("the interval is the Wilson bound, rounded outward and printed with 'to'", () => {
  // 822 of 1,284 turns: the first-try tile's own counts.
  const wilson = wilsonInterval(822, 1_284);
  assert.ok(wilson);
  const text = tileIntervalText(tile({ value: 822 / 1_284, interval: wilson }));
  assert.equal(text, `${Math.floor(wilson.low * 100)} to ${Math.ceil(wilson.high * 100)}%`);
  assert.equal(text, "61 to 67%");

  // Outward: the printed range always contains the computed one.
  const rounded = roundIntervalOutward({ low: 0.614, high: 0.666 }, "share");
  assert.ok(rounded.low <= 0.614 && rounded.high >= 0.666);
  // Exact percents do not get pushed a point out by float noise.
  assert.equal(tileIntervalText(tile({ interval: { low: 0.62, high: 0.67 } })), "62 to 67%");
  // A tight interval that rounds to one percent says so once.
  assert.equal(tileIntervalText(tile({ interval: { low: 0.58, high: 0.58 } })), "58%");
  // Clamped to [0, 100].
  assert.equal(tileIntervalText(tile({ interval: { low: 0, high: 1 } })), "0 to 100%");
  // Rates keep one decimal.
  assert.equal(
    tileIntervalText(
      tile({ value: 9.4, unit: "per_100_turns", interval: { low: 7.84, high: 11.21 } }),
    ),
    "7.8 to 11.3",
  );
  assert.equal(tileIntervalText(tile({ interval: null })), null);
});

test("the delta chip colours by upIsGood, not by direction", () => {
  const up = tileDelta(tile({ delta: 0.03, upIsGood: true }));
  assert.deepEqual(
    { direction: up?.direction, tone: up?.tone, text: up?.text },
    { direction: "up", tone: "good", text: "+3 pts" },
  );
  assert.equal(up?.description, "Up 3 points on the previous window, better");

  const upBad = tileDelta(tile({ delta: 0.03, upIsGood: false }));
  assert.equal(upBad?.tone, "bad");

  const downGood = tileDelta(tile({ delta: -0.02, upIsGood: false }));
  assert.deepEqual(
    { direction: downGood?.direction, tone: downGood?.tone, text: downGood?.text },
    { direction: "down", tone: "good", text: "−2 pts" },
  );
  assert.equal(tileDelta(tile({ delta: -0.02, upIsGood: true }))?.tone, "bad");

  const onePoint = tileDelta(tile({ delta: 0.01, upIsGood: true }));
  assert.match(onePoint?.description ?? "", /Up 1 point on/);

  const rate = tileDelta(tile({ value: 9.4, unit: "per_100_turns", delta: 1.1, upIsGood: false }));
  assert.deepEqual({ text: rate?.text, tone: rate?.tone }, { text: "+1.1", tone: "bad" });
});

test("a change that rounds to zero is flat and neutral, and no previous window means no chip", () => {
  for (const delta of [0, 0.004, -0.004]) {
    const flat = tileDelta(tile({ delta }));
    assert.equal(flat?.direction, "flat");
    assert.equal(flat?.tone, "neutral");
    assert.equal(flat?.text, "0 pts");
  }
  assert.equal(tileDelta(tile({ value: 9.4, unit: "per_100_turns", delta: 0.04 }))?.text, "0");
  assert.equal(tileDelta(tile({ delta: null })), null);
  assert.equal(tileDelta(tile({ delta: Number.NaN })), null);
});

test("every fixture tile reads without a two-decimal figure", () => {
  for (const each of MOCK_HEALTH_MODEL.tiles) {
    const printed = [
      tileFigure(each).value,
      tileIntervalText(each) ?? "",
      tileDelta(each)?.text ?? "",
      tileDelta(each)?.description ?? "",
      trendText(each) ?? "",
    ].join(" ");
    assert.doesNotMatch(printed, TWO_DECIMALS, `${each.key}: ${printed}`);
    assert.doesNotMatch(printed, /0\.\d/, `${each.key} prints a fraction: ${printed}`);
  }
});

test("the sparkline domain widens a flat week and keeps gaps as gaps", () => {
  const flat = sparkDomain(
    [
      { day: "a", value: 0.58 },
      { day: "b", value: 0.59 },
    ],
    "share",
  );
  assert.ok(flat);
  assert.ok(flat.max - flat.min >= 0.1, "a one-point wobble is not drawn as a cliff");
  assert.ok(flat.min <= 0.58 && flat.max >= 0.59);

  const nearZero = sparkDomain([{ day: "a", value: 0.01 }], "share");
  assert.equal(nearZero?.min, 0, "never below zero");

  assert.equal(sparkDomain([{ day: "a", value: null }], "share"), null);
  assert.deepEqual(gapSegments([0.1, null, 0.2, 0.3, null]), [[0], [2, 3]]);
  assert.deepEqual(gapSegments([null, null]), []);
});

test("the trend sentence names the first and last measured days", () => {
  assert.equal(trendText(MOCK_HEALTH_MODEL.tiles[0]), "Over 7 days: 61% to 67%.");
  assert.equal(trendText(MOCK_HEALTH_MODEL.tiles[3]), "Over 7 days: 8.2 to 9.9.");
  assert.equal(
    trendText(
      tile({
        series: [
          { day: "a", value: 0.5 },
          { day: "b", value: null },
        ],
      }),
    ),
    null,
    "one measured day is not a trend",
  );
});

test("only non-counted tiers carry a glyph label", () => {
  assert.equal(tierGlyphLabel("deterministic"), null);
  assert.equal(tierGlyphLabel("classifier"), "classifier scored");
  assert.equal(tierGlyphLabel("judge"), "model decided");
});

function shape(kind: TurnShapeView["shape"], share: number): TurnShapeView {
  return { shape: kind, label: kind, description: "", share, count: Math.round(share * 100) };
}

test("shapes sort by share, largest first, ties in catalog order", () => {
  const sorted = sortShapes([
    shape("repeat", 0.1),
    shape("blind", 0.1),
    shape("detour", 0.3),
    shape("direct", 0.3),
    shape("retry", 0.1),
    shape("dead_end", 0.1),
  ]);
  assert.deepEqual(
    sorted.map((each) => each.shape),
    ["direct", "detour", "dead_end", "retry", "blind", "repeat"],
  );

  const input = [shape("blind", 0.1), shape("direct", 0.9)];
  const copy = [...input];
  sortShapes(input);
  assert.deepEqual(input, copy, "the input is left alone");

  const fixture = sortShapes(MOCK_HEALTH_MODEL.shapes);
  assert.equal(fixture[0].shape, "direct");
  for (let index = 1; index < fixture.length; index += 1) {
    assert.ok(fixture[index - 1].share >= fixture[index].share);
  }
});

test("every shape has marks and a picture label, and the marks match the story", () => {
  for (const kind of TURN_SHAPE_KINDS) {
    assert.ok(SHAPE_MARKS[kind].length > 0, kind);
    assert.match(SHAPE_PICTURE_LABEL[kind], /^[A-Z][a-z ]+: /, kind);
  }
  assert.deepEqual(SHAPE_MARKS.detour, ["search", "search", "tool"]);
  assert.deepEqual(SHAPE_MARKS.retry, ["tool", "error", "tool"]);
  assert.deepEqual(SHAPE_MARKS.blind, ["tool"]);
  assert.equal(SHAPE_PICTURE_LABEL.detour, "Detour: searched twice before picking a tool");
  assert.equal(formatTurnCount(1), "1 turn");
  assert.equal(formatTurnCount(1_284), "1,284 turns");
});
