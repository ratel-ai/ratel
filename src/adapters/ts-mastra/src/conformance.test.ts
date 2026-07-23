import assert from "node:assert/strict";
import type { MastraDBMessage } from "@mastra/core/agent";
import { createTool, Tool } from "@mastra/core/tools";
import { SEARCH_CAPABILITIES_ID } from "@ratel-ai/sdk";
import {
  type AdapterConformanceOptions,
  type ConformanceToolSpec,
  describeAdapterConformance,
  type RecallExpectation,
} from "@ratel-ai/sdk/testkit";
import { describe, it } from "vitest";
import { type MastraTool, mastra } from "./mastra.js";

const TEST_CONTEXT = {
  observe: {
    async span<T>(_name: string, fn: () => T | Promise<T>): Promise<T> {
      return fn();
    },
    log(): void {},
  },
};

// The framework hooks that teach the shared conformance battery how to build
// Mastra tools, invoke exposed ones, and read back the recall message. Kept
// test-only: the testkit ships the reference worked example, so publishing ours
// would add a semver-bound API for zero users. Supplying makePassthroughTool
// (a Mastra tool with no `execute`) means 0 skips.
function mastraConformanceOptions(): AdapterConformanceOptions<MastraTool, MastraDBMessage> {
  return {
    adapter: mastra,
    // A neutral createTool id: the catalog id is the register key ingest is
    // handed, not the tool's own id, so this is irrelevant to registration.
    makeExecutableTool: (spec: ConformanceToolSpec) =>
      createTool({
        id: "conformance_exec",
        description: spec.description,
        execute: async () => spec.result ?? { ok: true },
      }),
    makePassthroughTool: (spec: ConformanceToolSpec) =>
      createTool({ id: "conformance_passthrough", description: spec.description }),
    callExposedTool: (tool, args) => {
      const execute = tool.execute as (input: unknown, context: unknown) => unknown;
      // Supply the minimal live context shape; the exposed capability preserves
      // it for any catalog tool reached through invoke_tool.
      return execute(args, TEST_CONTEXT);
    },
    validateRecallPair,
    validateExposedTool,
  };
}

describeAdapterConformance(mastraConformanceOptions(), { describe, it });

// The recall is ONE assistant message (a MastraDBMessage has no `tool` role): a
// single resolved `tool-invocation` part carrying the call args and the result.
function validateRecallPair(messages: MastraDBMessage[], expected: RecallExpectation): void {
  assert.equal(messages.length, 1, "recall is a single assistant message");
  const [message] = messages;
  assert.equal(message.role, "assistant", "the recall message is an assistant turn");
  assert.equal(message.content.format, 2, "content is format 2");
  const parts = message.content.parts;
  assert.equal(parts.length, 1, "one part");
  const part = parts[0] as { type: string; toolInvocation: Record<string, unknown> };
  assert.equal(part.type, "tool-invocation");
  const invocation = part.toolInvocation;
  assert.equal(invocation.state, "result", "a resolved tool-invocation carries args + result");
  assert.equal(invocation.toolCallId, expected.callId, "carries the expected call id");
  assert.equal(invocation.toolName, SEARCH_CAPABILITIES_ID);
  assert.deepEqual(
    invocation.args,
    { query: expected.query },
    "carries the query as the call args",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(invocation.result)),
    JSON.parse(JSON.stringify(expected.recall)),
    "carries the canonical recall (round-tripped)",
  );
}

// An `expose` codec output is a genuine Mastra tool: a `createTool` result (a
// `Tool` instance with an id, a description, and a callable execute).
function validateExposedTool(tool: MastraTool): void {
  assert.ok(tool instanceof Tool, "exposed tool is a Mastra createTool result");
  assert.equal(typeof tool.execute, "function", "exposed tool is callable");
  assert.equal(typeof tool.id, "string", "exposed tool keeps a Mastra id");
  assert.equal(typeof tool.description, "string", "exposed tool keeps a description");
}
