import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchResult, type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { Organization } from "@/lib/platform/organizations";
import type { VariantComparisonResult } from "@/lib/views/variants/compare-service";
import type { VariantWindow } from "@/lib/views/variants/compare-store";
import { compareVariants, type VariantSample } from "@/lib/views/variants/domain/compare";
import { type VariantOperationDeps, variantOperations } from "./variants";

/** RC-870: the variant tools against injected reads: the flag gate, the project scope, the window and the view. */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-08T00:00:00.000Z");
const org = { id: "org-1", slug: "acme" } as unknown as Organization;

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "free" },
};

function sample(name: string, runs: number, costUsd: number): VariantSample {
  return {
    name,
    attrs: { model: name, note: "x".repeat(500) },
    runs,
    errors: 2,
    inputTokens: runs * 100,
    outputTokens: runs * 10,
    traces: Array.from({ length: runs }, (_, i) => ({
      durationMs: 1_000 + i,
      costUsd,
      hasError: i < 2,
    })),
    health: { tool_errors: { n: runs, hits: 1 } },
    scorer: { n: runs, passed: runs - 1 },
  };
}

function harness(over: Partial<VariantOperationDeps> = {}) {
  const reads: { projectId: string; window: VariantWindow; experiment?: string }[] = [];
  const deps: VariantOperationDeps = {
    getOrganization: async () => org,
    enabled: async () => true,
    listVariantExperiments: async (projectId, window) => {
      reads.push({ projectId, window });
      return {
        experiments: [
          {
            experiment: "checkout",
            runs: 90,
            lastSeenAt: NOW.toISOString(),
            variants: [
              { name: "control", runs: 60 },
              { name: "haiku", runs: 30 },
            ],
          },
        ],
        truncated: false,
      };
    },
    getVariantComparison: async (projectId, experiment, window) => {
      reads.push({ projectId, window, experiment });
      if (experiment !== "checkout") return null;
      const result: VariantComparisonResult = {
        ...compareVariants("checkout", [
          sample("control", 60, 0.05),
          sample("haiku", 40, 0.01),
          sample("tiny", 5, 0.001),
        ]),
        window: { since: window.since.toISOString(), until: window.until.toISOString() },
        truncated: false,
      };
      return result;
    },
    now: () => NOW,
    ...over,
  };
  const run = (id: string, params: Record<string, unknown> = {}, caller: McpAuthContext = auth) =>
    dispatchOperation(id, params, {
      registry: buildRegistry(variantOperations(deps)),
      auth: caller,
    });
  return { run, reads };
}

function data<T>(result: DispatchResult): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as DispatchSuccess).data as T;
}

test("flag off: both tools refuse with forbidden and read nothing", async () => {
  const { run, reads } = harness({ enabled: async () => false });
  for (const [id, params] of [
    ["list_variant_experiments", {}],
    ["get_variant_experiment", { experiment: "checkout" }],
  ] as const) {
    const result = await run(id, params);
    assert.equal(result.ok, false);
    assert.equal((result as { error: string }).error, "forbidden");
  }
  assert.equal(reads.length, 0);
});

test("a project API key reads only its own project", async () => {
  const { run, reads } = harness();
  const refused = await run("get_variant_experiment", {
    projectId: OTHER_PROJECT,
    experiment: "checkout",
  });
  assert.equal((refused as { error: string }).error, "forbidden");
  data(await run("list_variant_experiments", {}));
  assert.deepEqual(
    reads.map((read) => read.projectId),
    [PROJECT],
  );
});

test("list: experiments with variants and run counts, over a 7-day default window", async () => {
  const { run, reads } = harness();
  const result = await run("list_variant_experiments");
  const listed = data<{
    experiments: { experiment: string; variants: { name: string; runs: number }[] }[];
  }>(result);
  assert.deepEqual(listed.experiments[0]!.variants, [
    { name: "control", runs: 60 },
    { name: "haiku", runs: 30 },
  ]);
  assert.equal(reads[0]!.window.since.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.deepEqual((result as DispatchSuccess).window, {
    since: "2026-11-01T00:00:00.000Z",
    until: NOW.toISOString(),
  });
});

test("get: per-variant figures with intervals, the baseline, the warning and the suggestion", async () => {
  const { run } = harness();
  type View = {
    baseline: { name: string; reason: string };
    variants: {
      name: string;
      attrs: Record<string, string>;
      errorRate: { value: number; low: number; high: number; n: number };
      latencyP50Ms: { value: number; low: number; high: number };
      latencyP95Ms: { value: number; low: number; high: number };
      costPerSuccessUsd: { value: number; low: number; high: number };
      tokens: { input: number; output: number; perRun: number };
      health: { kind: string; value: number; low: number; high: number }[];
      scorerPassRate: { value: number; low: number; high: number };
      warning: string | null;
    }[];
    suggestions: { variant: string; qualityBasis: string[] }[];
  };
  const result = await run("get_variant_experiment", { experiment: "checkout" });
  const view = data<View>(result);
  assert.deepEqual(view.baseline, { name: "control", reason: "named" });
  const haiku = view.variants.find((variant) => variant.name === "haiku")!;
  for (const figure of [
    haiku.errorRate,
    haiku.latencyP50Ms,
    haiku.latencyP95Ms,
    haiku.costPerSuccessUsd,
    haiku.scorerPassRate,
    haiku.health[0]!,
  ]) {
    assert.ok(figure.low <= figure.value && figure.value <= figure.high, JSON.stringify(figure));
  }
  assert.deepEqual(haiku.tokens, { input: 4_000, output: 400, perRun: 110 });
  assert.equal(haiku.attrs.note, `${"x".repeat(200)}…`);
  assert.equal((result as DispatchSuccess).truncated, true);
  assert.match(view.variants.find((variant) => variant.name === "tiny")!.warning!, /under the 30/);
  assert.deepEqual(
    view.suggestions.map((s) => [s.variant, s.qualityBasis]),
    [["haiku", ["error_rate", "scorer_pass_rate"]]],
  );
});

test("get: an experiment with no tagged trace in the window is not found", async () => {
  const { run } = harness();
  const result = await run("get_variant_experiment", { experiment: "missing" });
  assert.equal((result as { error: string }).error, "not_found");
});
