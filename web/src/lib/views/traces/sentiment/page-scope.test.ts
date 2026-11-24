import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import type { ProjectScope } from "@/lib/console/scope/project-scope";
import { sentimentAnalysisEnabled } from "@/lib/readings/trace-signals/outcomes/gate";
import { sentimentPageScope } from "@/lib/views/traces/sentiment/page-scope";

/**
 * Whether Sentiment analysis and Root cause analysis render or 404 (not an upstream file): both
 * pages ask `sentimentPageScope`, and `wiring.test.ts` checks that they do. The switch is the real
 * `sentimentAnalysis` flag, read from the environment as a deployment without an edition reads it.
 */

const SCOPE = {
  project: { id: "p1" },
  organization: { id: "o1" },
} as unknown as ProjectScope;

function deps(env: Record<string, string>, over: { dbConfigured?: boolean } = {}) {
  const asked: string[] = [];
  return {
    asked,
    deps: {
      dbConfigured: () => over.dbConfigured ?? true,
      getProjectScope: async (projectId: string) => {
        asked.push(projectId);
        return SCOPE;
      },
      enabled: (organization: ProjectScope["organization"]) =>
        sentimentAnalysisEnabled(organization, {
          config: resolveConfig({ env }),
          edition: "Ratel OSS",
          port: undefined,
        }),
    },
  };
}

test("FF_SENTIMENT_ANALYSIS unset: no scope, so the pages are not found", async () => {
  const off = deps({});
  assert.equal(await sentimentPageScope("p1", off.deps), null);
  assert.deepEqual(
    off.asked,
    ["p1"],
    "the project is still scoped first: a non-member never learns more",
  );
  assert.equal(await sentimentPageScope("p1", deps({ FF_SENTIMENT_ANALYSIS: "0" }).deps), null);
});

test("FF_SENTIMENT_ANALYSIS on: the project's scope", async () => {
  assert.equal(await sentimentPageScope("p1", deps({ FF_SENTIMENT_ANALYSIS: "1" }).deps), SCOPE);
  assert.equal(
    await sentimentPageScope("p1", deps({ RATEL_EXPERIMENTAL_FEATURES: "1" }).deps),
    SCOPE,
    "the experimental switch turns it on with the others",
  );
});

test("without a database there is no page, whatever the switch says, and nothing is read", async () => {
  const none = deps({ FF_SENTIMENT_ANALYSIS: "1" }, { dbConfigured: false });
  assert.equal(await sentimentPageScope("p1", none.deps), null);
  assert.deepEqual(none.asked, []);
});
