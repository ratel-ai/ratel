import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { sandboxesEnabledForProject } from "../gate";

test("sandboxes are off by default", async () => {
  assert.equal(await sandboxesEnabledForProject("p1", { config: resolveConfig() }), false);
});

test("FF_EVALS=1 turns sandboxes on: one flag gates sandboxes and evals", async () => {
  const config = resolveConfig({ env: { FF_EVALS: "1" } });
  assert.equal(await sandboxesEnabledForProject("p1", { config }), true);
});

test("with the edition's flags port, the edition decides for the project", async () => {
  const asked: unknown[] = [];
  const port = {
    enabled: async (flag: string, subject: unknown) => {
      asked.push([flag, subject]);
      return true;
    },
  };
  assert.equal(await sandboxesEnabledForProject("p1", { config: resolveConfig(), port }), true);
  assert.deepEqual(asked, [["evals", { projectId: "p1" }]]);
});
