import assert from "node:assert/strict";
import { test } from "node:test";
import { mixOrFallback, sourceBadgeText, sourceModeOf } from "@/lib/views/health/source-mode";

const mix = (declared: number, inferred: number, otlp: number) => ({ declared, inferred, otlp });

test("every turn from OpenTelemetry reads otel", () => {
  assert.equal(sourceModeOf(mix(0, 0, 120)), "otel");
});

test("SDK turns alone read sdk, declared or inferred", () => {
  assert.equal(sourceModeOf(mix(40, 0, 0)), "sdk");
  assert.equal(sourceModeOf(mix(0, 40, 0)), "sdk");
});

test("both sources read mixed", () => {
  assert.equal(sourceModeOf(mix(1, 0, 200)), "mixed");
  assert.equal(sourceModeOf(mix(0, 5, 1)), "mixed");
});

test("no turns, or no mix, keeps the SDK page", () => {
  assert.equal(sourceModeOf(mix(0, 0, 0)), "sdk");
  assert.equal(sourceModeOf(null), "sdk");
  assert.equal(sourceModeOf(undefined), "sdk");
});

test("negative counts from a bad row never flip the mode", () => {
  assert.equal(sourceModeOf(mix(-3, 0, 10)), "otel");
});

test("an empty stored mix falls back to the counted one", () => {
  const counted = mix(0, 0, 9);
  assert.deepEqual(mixOrFallback(mix(0, 0, 0), counted), counted);
  assert.deepEqual(mixOrFallback(null, counted), counted);
  assert.deepEqual(mixOrFallback(mix(2, 0, 0), counted), mix(2, 0, 0));
});

test("the badge names the source, and the SDK page has none", () => {
  assert.equal(sourceBadgeText("otel"), "From OpenTelemetry");
  assert.equal(sourceBadgeText("mixed"), "SDK + OpenTelemetry");
  assert.equal(sourceBadgeText("sdk"), null);
});
