import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { sandboxesEnabledForProject } from "../gate";

test("sandboxes are off by default", async () => {
  assert.equal(await sandboxesEnabledForProject("p1", { config: resolveConfig() }), false);
});

test("FF_SANDBOXES=1 turns sandboxes on", async () => {
  const config = resolveConfig({ env: { FF_SANDBOXES: "1" } });
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
  assert.deepEqual(asked, [["sandboxes", { projectId: "p1" }]]);
});
