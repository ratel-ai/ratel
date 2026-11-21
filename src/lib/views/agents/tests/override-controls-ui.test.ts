import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import {
  AgentOverrideControls,
  mergePickerProps,
} from "@/components/console/agents/AgentOverrideControls";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";

/** RC-776 controls; RC-858: the merge picker stays uncontrolled, so no console error in dev. */

const TARGETS = [
  { key: "flights", name: "flights" },
  { key: "hotels", name: "Hotel search" },
];

test("the merge picker never passes a value: Base UI's Select stays uncontrolled for its whole life", () => {
  let picked: string | null = null;
  const props = mergePickerProps(TARGETS, (key) => {
    picked = key;
  });
  assert.equal("value" in props, false);
  assert.equal("defaultValue" in props, false);
  assert.deepEqual(props.options, [
    { value: "flights", label: "flights" },
    { value: "hotels", label: "Hotel search" },
  ]);
  props.onValueChange?.("hotels");
  assert.equal(picked, "hotels");
});

test("an agent with no merge into it offers rename, hide and the merge picker; a merge target offers undo instead", () => {
  const base = {
    apiHref: `/api/projects/${PROJECT_ID}/agents/overrides`,
    agentKey: "pricing",
    displayName: null,
    hidden: false,
  };
  const free = visibleText(
    render(
      createElement(AgentOverrideControls, { ...base, mergedKeys: [], mergeTargets: TARGETS }),
    ),
  );
  for (const word of ["Display name", "Hide this agent", "Same agent as", "Merge"])
    assert.ok(free.includes(word), word);
  assert.ok(!free.includes("Undo merge"));
  const target = visibleText(
    render(
      createElement(AgentOverrideControls, {
        ...base,
        agentKey: "flights",
        mergedKeys: ["pricing"],
        mergeTargets: TARGETS,
      }),
    ),
  );
  assert.ok(target.includes("Undo merge"));
  assert.ok(!target.includes("Same agent as"), "a merge target cannot be merged itself");
});
