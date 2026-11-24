import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveScorersPage, type ScorersPageDeps } from "./context";

const scope = {
  project: { id: "p1" },
  organization: { id: "o1" },
  user: { externalId: "u1" },
} as Awaited<ReturnType<ScorersPageDeps["requireProjectScope"]>>;
const is404 = (err: { digest?: string }) => String(err.digest).includes("404");

test("flag off: the pages are not found; on: they resolve the project", async () => {
  const asked: unknown[] = [];
  const deps = (on: boolean): ScorersPageDeps => ({
    requireProjectScope: async () => scope,
    featureEnabled: async (...args) => {
      asked.push(args);
      return on;
    },
  });
  await assert.rejects(resolveScorersPage("p1", deps(false)), is404);
  assert.deepEqual(await resolveScorersPage("p1", deps(true)), { projectId: "p1" });
  assert.deepEqual(asked[0], ["scorers", { projectId: "p1", organizationId: "o1", actor: "u1" }]);
});
