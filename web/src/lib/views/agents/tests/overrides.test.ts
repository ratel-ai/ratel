import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentOverride,
  agentsAsOverridden,
  applyOverrideChange,
  canonicalKey,
  displayNameOf,
  isEmptyOverride,
  overrideView,
  sourceKeys,
} from "../domain/overrides";

const row = (agentKey: string, patch: Partial<AgentOverride> = {}): AgentOverride => ({
  agentKey,
  displayName: null,
  hidden: false,
  mergedInto: null,
  ...patch,
});

test("a change keeps the fields it leaves out and clears the ones set to null", () => {
  const current = [row("researcher", { displayName: "Researcher", hidden: true })];
  assert.deepEqual(applyOverrideChange(current, { agentKey: "researcher", hidden: false }), {
    ok: true,
    override: row("researcher", { displayName: "Researcher" }),
  });
  assert.deepEqual(applyOverrideChange(current, { agentKey: "researcher", displayName: null }), {
    ok: true,
    override: row("researcher", { hidden: true }),
  });
  assert.deepEqual(applyOverrideChange([], { agentKey: "writer", displayName: "  Copywriter  " }), {
    ok: true,
    override: row("writer", { displayName: "Copywriter" }),
  });
});

test("a merge into itself, into a merged agent, or of a merge target is rejected: no chains, no cycles", () => {
  const current = [row("research-v1", { mergedInto: "researcher" })];
  assert.deepEqual(applyOverrideChange([], { agentKey: "a", mergedInto: "a" }), {
    ok: false,
    reason: "merge_into_itself",
  });
  assert.deepEqual(
    applyOverrideChange(current, { agentKey: "writer", mergedInto: "research-v1" }),
    { ok: false, reason: "merge_target_is_merged" },
  );
  assert.deepEqual(applyOverrideChange(current, { agentKey: "researcher", mergedInto: "writer" }), {
    ok: false,
    reason: "agent_is_merge_target",
  });
  // The cycle researcher -> research-v1 -> researcher is the same rejection.
  assert.deepEqual(
    applyOverrideChange(current, { agentKey: "researcher", mergedInto: "research-v1" }),
    { ok: false, reason: "merge_target_is_merged" },
  );
});

test("a second key can merge into the same target, and undo clears the merge", () => {
  const current = [row("research-v1", { mergedInto: "researcher" })];
  assert.deepEqual(
    applyOverrideChange(current, { agentKey: "research-v2", mergedInto: "researcher" }),
    { ok: true, override: row("research-v2", { mergedInto: "researcher" }) },
  );
  const undone = applyOverrideChange(current, { agentKey: "research-v1", mergedInto: null });
  assert.ok(undone.ok && isEmptyOverride(undone.override));
});

test("the read view maps merges, names and hidden keys", () => {
  const view = overrideView([
    row("research-v1", { mergedInto: "researcher" }),
    row("research-v2", { mergedInto: "researcher" }),
    row("researcher", { displayName: "Researcher" }),
    row("ops", { hidden: true }),
  ]);
  assert.equal(canonicalKey(view, "research-v1"), "researcher");
  assert.equal(canonicalKey(view, "writer"), "writer");
  assert.deepEqual(sourceKeys(view, "researcher"), ["researcher", "research-v1", "research-v2"]);
  assert.deepEqual(sourceKeys(view, "writer"), ["writer"]);
  assert.equal(displayNameOf(view, "researcher"), "Researcher");
  assert.equal(displayNameOf(view, "writer"), "writer");
  assert.ok(view.hidden.has("ops"));
});

test("another surface's per-agent counts sum merges under the target's override name", () => {
  const overrides = [
    row("research-v1", { mergedInto: "researcher" }),
    row("researcher", { displayName: "Researcher" }),
  ];
  assert.deepEqual(
    agentsAsOverridden(
      [
        { agent: "researcher", calls: 2 },
        { agent: null, calls: 4 },
        { agent: "research-v1", calls: 3 },
        { agent: "writer", calls: 1 },
      ],
      overrides,
    ),
    [
      { agent: "Researcher", calls: 5 },
      { agent: null, calls: 4 },
      { agent: "writer", calls: 1 },
    ],
  );
  assert.deepEqual(agentsAsOverridden([{ agent: "a", calls: 1 }], []), [{ agent: "a", calls: 1 }]);
});
