import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyChange } from "@/lib/views/eval-gate/change";
import { type Recording, type ReplayInput, replayInput } from "@/lib/views/eval-gate/replay";
import type { FixChange, ToolDef } from "@/lib/views/eval-gate/types";

/**
 * RC-175: the What-if fork calls `replayInput` (shared with the eval gate)
 * unchanged. These goldens pin its output byte for byte, so a change to it
 * shows here before it moves What-if results.
 *
 * Pinned on `replayInput` after PR #314 (RC-76, faithful replays): the
 * recording has an earlier turn's call (`earlier`). The fork tests read only
 * the shape of `replayInput`'s output, never these bytes.
 */

const tool = (name: string): ToolDef => ({
  name,
  description: `${name} does its job.`,
  parameters: { type: "object", properties: { ref: { type: "string" } } },
});

const RECORDING: Recording = {
  history: [
    { role: "user", text: "What does booking R1 cost?" },
    {
      role: "assistant",
      text: "",
      calls: [{ id: "toolu_e0", name: "get_fare", args: { ref: "R1" } }],
    },
    { role: "tool", callId: "toolu_e0", content: '{"fare":120}', isError: false },
    { role: "assistant", text: "It costs 120.", calls: [] },
    { role: "user", text: "Hold the fare for booking R1" },
  ],
  system: "You are a travel agent.",
  tools: ["find_booking", "get_fare", "hold_fare", "cancel_fare"].map(tool),
  calls: [
    {
      id: "toolu_0",
      name: "find_booking",
      args: { ref: "R1" },
      result: '{"booking":"R1"}',
      isError: false,
    },
    {
      id: "toolu_1",
      name: "hold_fare",
      args: { ref: "R1" },
      result: '{"error":"fare_no_longer_available"}',
      isError: true,
    },
  ],
  earlier: [
    {
      id: "toolu_e0",
      name: "get_fare",
      args: { ref: "R1" },
      result: '{"fare":120}',
      isError: false,
    },
  ],
  model: "claude-sonnet-4-6",
  toolMs: 120,
  inputTokens: 900,
};

const EVERY_BRANCH: FixChange = {
  ...emptyChange(),
  replay: {
    tools: [
      {
        name: "cancel_fare",
        description: "Cancels a held fare.",
        parameters: { type: "object", properties: { hold: { type: "string" } } },
        replaces: [],
      },
      {
        name: "book_and_quote",
        description: "Finds a booking and quotes its fare.",
        parameters: { type: "object", properties: { ref: { type: "string" } } },
        replaces: ["find_booking", "get_fare"],
      },
      {
        name: "ghost",
        description: "Replaces nothing offered.",
        parameters: {},
        replaces: ["absent"],
      },
    ],
    failClearly: ["hold_fare", "absent"],
    prerequisite: { before: "book_and_quote", tool: "hold_fare" },
    skill: { name: "Hold a fare", steps: ["book_and_quote", "hold_fare", "notify_user"] },
  },
};

const TOOL_DEFS = new Map<string, ToolDef>([["notify_user", tool("notify_user")]]);

function serialized(input: ReplayInput): string {
  return JSON.stringify({
    ...input,
    failClearly: [...input.failClearly],
    merged: [...input.merged.entries()],
  });
}

test("golden: replayInput's control is the recording as it was", () => {
  assert.equal(serialized(replayInput(RECORDING, null, TOOL_DEFS)), GOLDEN_CONTROL);
});

test("golden: replayInput with a change through every branch", () => {
  assert.equal(serialized(replayInput(RECORDING, EVERY_BRANCH, TOOL_DEFS)), GOLDEN_EVERY_BRANCH);
});

const GOLDEN_CONTROL =
  '{"system":"You are a travel agent.","tools":[{"name":"find_booking","description":"find_booking does its job.","parameters":{"type":"object","properties":{"ref":{"type":"string"}}}},{"name":"get_fare","description":"get_fare does its job.","parameters":{"type":"object","properties":{"ref":{"type":"string"}}}},{"name":"hold_fare","description":"hold_fare does its job.","parameters":{"type":"object","properties":{"ref":{"type":"string"}}}},{"name":"cancel_fare","description":"cancel_fare does its job.","parameters":{"type":"object","properties":{"ref":{"type":"string"}}}}],"failClearly":[],"merged":[],"touched":false}';
const GOLDEN_EVERY_BRANCH =
  '{"system":"You are a travel agent.\\n\\nSkill \\"Hold a fare\\": for requests like this one, run these steps in order: book_and_quote, then hold_fare, then notify_user.","tools":[{"name":"hold_fare","description":"hold_fare does its job. When it fails, it says why and whether trying again can help. Run book_and_quote first, and use what it returns.","parameters":{"type":"object","properties":{"ref":{"type":"string"}}}},{"name":"cancel_fare","description":"Cancels a held fare.","parameters":{"type":"object","properties":{"hold":{"type":"string"}}}},{"name":"book_and_quote","description":"Finds a booking and quotes its fare.","parameters":{"type":"object","properties":{"ref":{"type":"string"}}},"replaces":["find_booking","get_fare"]},{"name":"notify_user","description":"notify_user does its job.","parameters":{"type":"object","properties":{"ref":{"type":"string"}}}}],"failClearly":["hold_fare"],"merged":[["book_and_quote",["find_booking","get_fare"]]],"touched":true}';
