import assert from "node:assert/strict";
import { test } from "node:test";
import {
  currentVersion,
  type EvalDefinition,
  evalContentSchema,
  evalDetailsSchema,
  runProblem,
  sameContent,
} from "../domain/eval";
import { evalContent, NO_REFUND, PROJECT_ID } from "./support";

const JUDGE = {
  id: "polite",
  name: "Polite",
  gating: false,
  definition: { kind: "judge" as const, config: { prompt: "polite?", output: "boolean" as const } },
};

test("an eval has a name, an optional task, and defaults for the sandbox, the params and the trials", () => {
  assert.deepEqual(evalDetailsSchema.parse({ name: " Refunds " }), {
    name: "Refunds",
    taskId: null,
  });
  assert.equal(evalDetailsSchema.safeParse({ name: " " }).success, false);
  assert.deepEqual(evalContentSchema.parse({}), {
    datasetId: null,
    sandboxName: null,
    sandboxVersionId: null,
    params: {},
    matrix: {},
    trials: 3,
    scorers: [],
  });
  assert.equal(evalContentSchema.safeParse({ trials: 0 }).success, false);
  assert.equal(evalContentSchema.safeParse({ trials: 21 }).success, false);
});

test("the scorers of an eval take the shared definitions with the paths of a trial only", () => {
  const check = (config: object) =>
    evalContentSchema.safeParse({
      // biome-ignore lint/suspicious/noExplicitAny: a wrong config is the point
      scorers: [{ ...NO_REFUND, definition: { kind: "check", config: config as any } }],
    }).success;
  for (const path of [
    "output",
    "output.status",
    "tools",
    "duration_ms",
    "cost_usd",
    "tool_arguments.refund_order.order_id",
  ]) {
    assert.ok(check({ path, op: "eq", value: "1" }), path);
  }
  for (const path of ["attributes.x", "models", "tool_arguments.refund_order", "output.", "x"]) {
    assert.ok(!check({ path, op: "eq", value: "1" }), path);
  }
  assert.ok(check({ path: "output", op: "exists" }));
  assert.ok(!check({ path: "output", op: "eq" }));
  assert.ok(!check({ path: "cost_usd", op: "lt", value: "cheap" }));
  const judge = (output: string) =>
    evalContentSchema.safeParse({
      scorers: [{ ...JUDGE, definition: { kind: "judge", config: { prompt: "ok?", output } } }],
    }).success;
  assert.ok(judge("boolean"));
  assert.ok(!judge("numeric"));
});

test("an eval has at most 5 judges and no two scorers with one id", () => {
  const judges = Array.from({ length: 6 }, (_, n) => ({ ...JUDGE, id: `j${n}` }));
  assert.equal(evalContentSchema.safeParse({ scorers: judges }).success, false);
  assert.equal(evalContentSchema.safeParse({ scorers: judges.slice(1) }).success, true);
  assert.equal(evalContentSchema.safeParse({ scorers: [NO_REFUND, NO_REFUND] }).success, false);
});

test("an eval runs only with a gating scorer", () => {
  assert.equal(runProblem(evalContent()), null);
  assert.match(runProblem(evalContent({ scorers: [JUDGE] })) ?? "", /gating/);
  assert.match(runProblem(evalContent({ scorers: [] })) ?? "", /gating/);
});

test("an edit with the same content is the same version", () => {
  assert.ok(sameContent(evalContent(), evalContent()));
  assert.ok(!sameContent(evalContent(), evalContent({ trials: 5 })));
  assert.ok(!sameContent(evalContent(), evalContent({ scorers: [NO_REFUND, JUDGE] })));
  assert.ok(!sameContent(evalContent(), evalContent({ sandboxName: "support-demo" })));
});

test("the current version of an eval is its newest", () => {
  const refunds = definition("e1", "Refunds", [
    version("e1v2", 2, [NO_REFUND, JUDGE]),
    version("e1v1", 1, [NO_REFUND]),
  ]);
  assert.equal(currentVersion(refunds).id, "e1v2");
});

function definition(id: string, name: string, versions: EvalDefinition["versions"]) {
  return { id, projectId: PROJECT_ID, name, taskId: null, createdAt: new Date(0), versions };
}

function version(id: string, number: number, scorers: (typeof NO_REFUND)[]) {
  return {
    ...evalContent({ scorers }),
    id,
    evalId: id.slice(0, 2),
    number,
    createdBy: "user_1",
    createdAt: new Date(0),
  };
}
