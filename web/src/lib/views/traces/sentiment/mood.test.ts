import assert from "node:assert/strict";
import { test } from "node:test";
import { dayStops, moodColor } from "@/lib/views/traces/sentiment/mood";

test("a value has one color: red unsatisfied, yellow mixed, green satisfied", () => {
  assert.equal(moodColor(0), "#f75b6b");
  assert.equal(moodColor(0.55), "rgb(237, 179, 69)");
  assert.equal(moodColor(1), "#5ac576");
});

test("the graph is colored along the days: each day's stop is its own value's color", () => {
  const stops = dayStops([0.9, 0.2, 0.9]);
  const at = (offset: number) => stops.find((stop) => stop.offset === offset)?.color;
  assert.equal(at(0), moodColor(0.9));
  assert.equal(at(0.5), moodColor(0.2));
  assert.equal(at(1), moodColor(0.9));
  assert.ok(stops.every((stop, i) => i === 0 || stop.offset >= stops[i - 1]!.offset));
});

test("between two days the color follows the line through yellow, never a straight red-green mix", () => {
  const middle = dayStops([1, 0]).find((stop) => stop.offset === 0.5)!;
  assert.equal(middle.color, moodColor(0.5));
});

test("days without an answer have no stop, and one day alone colors the whole graph", () => {
  assert.deepEqual(
    dayStops([null, 0.9, null]).map((stop) => stop.color),
    [moodColor(0.9)],
  );
  assert.deepEqual(dayStops([null, null]), []);
});
