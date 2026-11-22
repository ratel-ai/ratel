import assert from "node:assert/strict";
import { test } from "node:test";
import { activeNavItemId, commandEntries, consoleNav, flattenNav } from "@/lib/console/navigation";

/**
 * Owned (ADR-0030): upstream's case on the core's rail (`consoleNav`, one list with sections):
 * Evals sits last under Improvements only with `FF_EVALS` on, the top level keeps its budget,
 * the item lights on its pages, and ⌘K finds it only with the switch on.
 */
const ID = "11111111-1111-4111-8111-111111111111";

test("with FF_EVALS off the rail and ⌘K are unchanged: no Evals item", () => {
  const off = consoleNav({ projectId: ID, additions: [] });
  assert.deepEqual(off, consoleNav({ projectId: ID, additions: [], evals: false }));
  assert.ok(!flattenNav(off).some((item) => item.id === "evals"));
  assert.ok(
    !commandEntries({ items: off, projectId: ID, projects: [], pathname: `/project/${ID}` }).some(
      (entry) => entry.href === `/project/${ID}/evals`,
    ),
  );
});

test("Evals sits last under Improvements with the flag on, so the rail keeps its budget (RC-775)", () => {
  const items = consoleNav({ projectId: ID, additions: [], fineTuning: true, evals: true });
  const improvements = items.find((item) => item.id === "improvements");
  assert.equal(improvements?.children?.at(-1)?.id, "evals");
  const top = (options: { evals?: boolean }) =>
    consoleNav({ projectId: ID, additions: [], ...options }).map((item) => item.label);
  assert.deepEqual(top({ evals: true }), top({}));
});

test("the Evals item lights on its pages and ⌘K finds it only with the flag on", () => {
  const items = consoleNav({ projectId: ID, additions: [], evals: true });
  assert.equal(activeNavItemId(`/project/${ID}/evals/runs/abc`, items), "evals");
  assert.ok(
    commandEntries({ items, projectId: ID, projects: [], pathname: `/project/${ID}` }).some(
      (entry) => entry.href === `/project/${ID}/evals`,
    ),
  );
});
