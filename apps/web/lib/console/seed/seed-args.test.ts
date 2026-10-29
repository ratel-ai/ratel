import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSeedArgs } from "@/lib/console/seed/seed-args";
import { SITE_COPILOT_SEED, SITE_COPILOT_TURNS } from "@/lib/console/seed/site-copilot-plan";

const NOW = Date.parse("2026-03-04T05:06:59.123Z");

test("defaults: no org, site-copilot, now to the minute, the plan's turns and seed", () => {
  assert.deepEqual(parseSeedArgs([], NOW), {
    org: undefined,
    slug: "site-copilot",
    anchorMs: Date.parse("2026-03-04T05:06:00.000Z"),
    turns: SITE_COPILOT_TURNS,
    seed: SITE_COPILOT_SEED,
  });
});

test("reads the org positional and every flag, in any order", () => {
  const argv = [
    "--turns",
    "20",
    "acme",
    "--slug",
    "demo",
    "--anchor",
    "2026-01-01T00:00:00Z",
    "--seed",
    "-3",
  ];
  assert.deepEqual(parseSeedArgs(argv, NOW), {
    org: "acme",
    slug: "demo",
    anchorMs: Date.parse("2026-01-01T00:00:00Z"),
    turns: 20,
    seed: -3,
  });
});

test("a flag's value is never the org", () => {
  assert.equal(parseSeedArgs(["--slug", "demo"], NOW).org, undefined);
});

test("rejects unknown flags and bad values", () => {
  assert.throws(() => parseSeedArgs(["--org", "acme"], NOW), /unknown flag --org/);
  assert.throws(() => parseSeedArgs(["--anchor", "soon"], NOW), /--anchor is not a date: soon/);
  assert.throws(() => parseSeedArgs(["--turns", "0"], NOW), /--turns takes a positive integer/);
  assert.throws(() => parseSeedArgs(["--turns", "1.5"], NOW), /--turns takes a positive integer/);
  assert.throws(() => parseSeedArgs(["--seed", "x"], NOW), /--seed takes an integer/);
});
