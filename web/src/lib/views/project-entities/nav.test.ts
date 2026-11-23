import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { activeNavItemId, consoleNav, flattenNav } from "@/lib/console/navigation";
import { projectEntitiesEnabled } from "./flag";
import { entityPagesOrganizationIds } from "./nav";

/**
 * RP-28: `agentsPages` at the rail. Off, the rail is what it was; on, Traces holds All
 * traces, Agents and MCP servers (the owner's decision: always, whatever the project's data).
 */

const P1 = "p1";
const ORGANIZATIONS = [{ id: "org-1" }, { id: "org-2" }];

test("flag off: no organization shows the pages, and the rail is unchanged", async () => {
  const ids = await entityPagesOrganizationIds(ORGANIZATIONS, (organization) =>
    projectEntitiesEnabled(organization, resolveConfig()),
  );
  assert.equal(ids.length, 0);
  const off = consoleNav({ projectId: P1, additions: [], entityPages: ids.includes("org-1") });
  assert.deepEqual(off, consoleNav({ projectId: P1, additions: [] }));
  const traces = off.find((item) => item.id === "traces");
  assert.equal(traces?.children, undefined);
  const railIds = flattenNav(off).map((item) => item.id);
  assert.ok(!railIds.includes("agents") && !railIds.includes("mcp-servers"));
});

test("flag on: every organization shows the pages, and Traces holds All traces, Agents and MCP servers", async () => {
  const ids = await entityPagesOrganizationIds(ORGANIZATIONS, (organization) =>
    projectEntitiesEnabled(
      organization,
      resolveConfig({ override: { flags: { agentsPages: true } } }),
    ),
  );
  assert.deepEqual(ids, ["org-1", "org-2"]);
  const on = consoleNav({ projectId: P1, additions: [], entityPages: true });
  const traces = on.find((item) => item.id === "traces");
  assert.deepEqual(
    traces?.children?.map(({ id, label, href }) => ({ id, label, href })),
    [
      { id: "traces-all", label: "All traces", href: "/project/p1/traces" },
      { id: "agents", label: "Agents", href: "/project/p1/agents" },
      { id: "mcp-servers", label: "MCP servers", href: "/project/p1/mcp" },
    ],
  );
  assert.equal(activeNavItemId("/project/p1/agents/claude", on), "agents");
  assert.equal(activeNavItemId("/project/p1/mcp/slack", on), "mcp-servers");
  assert.equal(activeNavItemId("/project/p1/traces/turns", on), "traces");
});

test("a failed decision hides the pages for that organization only", async () => {
  const ids = await entityPagesOrganizationIds(ORGANIZATIONS, async (organization) => {
    if (organization.id === "org-1") throw new Error("flag service down");
    return true;
  });
  assert.deepEqual(ids, ["org-2"]);
});
