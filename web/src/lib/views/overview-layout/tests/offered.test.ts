import assert from "node:assert/strict";
import { test } from "node:test";
import { projectWidgets } from "../offered";

const offered = async (organization: { id: string } | null, on: boolean) => {
  const asked: unknown[] = [];
  const widgets = await projectWidgets("p1", {
    organization: async () => organization,
    customMonitoring: async (subject) => {
      asked.push(subject);
      return on;
    },
  });
  return { ids: widgets.map(({ id }) => id), asked };
};

test("the Alerts widget is offered where the project's organization has the flag", async () => {
  const on = await offered({ id: "o1" }, true);
  assert.ok(on.ids.includes("alerts"));
  assert.deepEqual(on.asked, [{ projectId: "p1", organizationId: "o1" }]);
  assert.ok(!(await offered({ id: "o1" }, false)).ids.includes("alerts"));
  const unknown = await offered(null, true);
  assert.ok(!unknown.ids.includes("alerts"));
  assert.deepEqual(unknown.asked, []);
});
