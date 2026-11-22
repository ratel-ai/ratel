import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ANALYST_MODEL } from "./analyst";
import type { AnalystContext } from "./context";
import { parseMatchQualityPayload, resolveAnalystFactory } from "./job";
import { MOCK_ANALYST_MODEL } from "./mock";

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const VALID = {
  runId: "r1",
  projectId: "p1",
  projectName: "acme-mcp",
  experimentName: "mcp_search_operations",
  windowStart: "2026-09-07T12:00:00.000Z",
  windowEnd: "2026-09-14T12:00:00.000Z",
};

const CONTEXT = {
  projectName: "p",
  census: {},
  retrieval: { stages: [], topK: null, samples: 0 },
  quality: [],
  gapNote: null,
  referenceAccuracy: null,
  corpus: [],
  candidates: [],
} as unknown as AnalystContext;

test("a well-formed payload parses", () => {
  assert.deepEqual(parseMatchQualityPayload(VALID), VALID);
});

test("a payload missing any field is refused rather than half-run", () => {
  for (const field of Object.keys(VALID)) {
    const broken = { ...VALID, [field]: undefined };
    assert.equal(parseMatchQualityPayload(broken), null, `${field} must be required`);
  }
});

test("an empty string is not a valid id", () => {
  assert.equal(parseMatchQualityPayload({ ...VALID, runId: "" }), null);
});

test("an unparseable window is refused, so a run cannot read an Invalid Date range", () => {
  assert.equal(parseMatchQualityPayload({ ...VALID, windowStart: "not a date" }), null);
  assert.equal(parseMatchQualityPayload({ ...VALID, windowEnd: "yesterday" }), null);
});

test("junk payloads are refused without throwing", () => {
  assert.equal(parseMatchQualityPayload(null), null);
  assert.equal(parseMatchQualityPayload(undefined), null);
  assert.equal(parseMatchQualityPayload("string"), null);
  assert.equal(parseMatchQualityPayload(42), null);
  assert.equal(parseMatchQualityPayload([]), null);
});

test("no key and no mock means no analyst, not a thrown run", () => {
  withEnv(
    { ANTHROPIC_API_KEY: undefined, MATCH_QUALITY_MOCK_ANALYST: undefined, APP_ENV: "development" },
    () => {
      const resolved = resolveAnalystFactory();
      assert.equal(resolved.analyst, undefined);
      assert.equal(resolved.mocked, false);
    },
  );
});

test("a configured key gives the real model", () => {
  withEnv(
    {
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_MODEL: undefined,
      MATCH_QUALITY_MOCK_ANALYST: undefined,
      APP_ENV: "development",
    },
    () => {
      const resolved = resolveAnalystFactory();
      assert.equal(resolved.mocked, false);
      assert.equal(resolved.analyst?.(CONTEXT).model, DEFAULT_ANALYST_MODEL);
    },
  );
});

test("ANTHROPIC_MODEL overrides the default", () => {
  withEnv(
    {
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_MODEL: "claude-opus-5",
      MATCH_QUALITY_MOCK_ANALYST: undefined,
      APP_ENV: "development",
    },
    () => {
      assert.equal(resolveAnalystFactory().analyst?.(CONTEXT).model, "claude-opus-5");
    },
  );
});

test("the local mock wins over a real key, so a laptop cannot spend one by accident", () => {
  withEnv(
    {
      ANTHROPIC_API_KEY: "sk-ant-test",
      MATCH_QUALITY_MOCK_ANALYST: "1",
      APP_ENV: "development",
    },
    () => {
      const resolved = resolveAnalystFactory();
      assert.equal(resolved.mocked, true);
      assert.equal(resolved.analyst?.(CONTEXT).model, MOCK_ANALYST_MODEL);
    },
  );
});

test("the mock request is ignored in production, which falls back to the real model", () => {
  withEnv(
    {
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_MODEL: undefined,
      MATCH_QUALITY_MOCK_ANALYST: "1",
      APP_ENV: "production",
    },
    () => {
      const resolved = resolveAnalystFactory();
      assert.equal(resolved.mocked, false);
      assert.equal(resolved.analyst?.(CONTEXT).model, DEFAULT_ANALYST_MODEL);
    },
  );
});
