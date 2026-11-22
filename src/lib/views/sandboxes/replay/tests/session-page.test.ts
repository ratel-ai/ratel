import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxRunnerView } from "../../ports/store";
import {
  loadSessionReplay,
  loadSessionReplayLink,
  NO_RUNNER_MESSAGE,
  NOT_CHAT_MESSAGE,
  type SessionReplayDeps,
} from "../session-page";
import { NOT_REPLAYABLE_MESSAGES, type ReplaySourceResult } from "../session-source";

/** "Replay in sandbox" on a session page: the sandbox in the caller's runner, or why replay is not possible. */

const ME = "user_me";
const chatSandbox = (id: string) => ({ id, input: { kind: "chat" }, params: [] });

function runner(
  sandboxes: unknown[],
  overrides: Partial<SandboxRunnerView> = {},
): SandboxRunnerView {
  return {
    id: "r",
    ownerUserId: ME,
    instanceId: "i",
    online: true,
    manifest: { sandboxes },
    maxConcurrency: 1,
    connectedAt: new Date("2026-11-20T10:00:00Z"),
    lastSeenAt: new Date("2026-11-20T10:00:00Z"),
    ...overrides,
  };
}

function source(sandboxId: string | null, agentName: string | null): ReplaySourceResult {
  return {
    replayable: true,
    sessionId: "s1",
    sandboxId,
    agentName,
    turns: [{ turnIndex: 0, traceId: "t", userMessage: "hi", toolCalls: [] }],
  };
}

function deps(runners: SandboxRunnerView[], result: ReplaySourceResult): SessionReplayDeps {
  return { listRunners: async () => runners, sessionSource: async () => result };
}

const scope = { projectId: "p 1", externalId: ME, sessionId: "s/1" };

test("the link goes to the sandbox of ratel.sandbox.id first, else of the agent name", async () => {
  const both = await loadSessionReplayLink(
    scope,
    deps(
      [runner([chatSandbox("docs-agent"), chatSandbox("docs-sandbox")])],
      source("docs-sandbox", "docs-agent"),
    ),
  );
  assert.deepEqual(both, {
    state: "ready",
    href: "/project/p%201/sandboxes/docs-sandbox?session=s%2F1",
    sandboxId: "docs-sandbox",
    by: "sandbox_id",
    turns: 1,
  });
  const byName = await loadSessionReplayLink(
    scope,
    deps([runner([chatSandbox("docs-agent")])], source("docs-sandbox", "docs-agent")),
  );
  assert.deepEqual(byName.state === "ready" ? [byName.sandboxId, byName.by] : null, [
    "docs-agent",
    "agent_name",
  ]);
});

test("a structured sandbox, another user's runner or no runner never match", async () => {
  const structured = await loadSessionReplayLink(
    scope,
    deps(
      [runner([{ id: "docs-agent", input: { kind: "structured", schema: {} }, params: [] }])],
      source(null, "docs-agent"),
    ),
  );
  assert.deepEqual(structured, {
    state: "unavailable",
    message: 'Your runner has no chat sandbox for agent "docs-agent".',
  });
  const theirs = await loadSessionReplayLink(
    scope,
    deps(
      [runner([chatSandbox("docs-agent")], { ownerUserId: "user_them" })],
      source(null, "docs-agent"),
    ),
  );
  assert.deepEqual(theirs, { state: "unavailable", message: NO_RUNNER_MESSAGE });
});

test("a session that cannot replay says why, before any runner check", async () => {
  const result: ReplaySourceResult = {
    replayable: false,
    sessionId: "s1",
    reason: "no_message_content",
    message: NOT_REPLAYABLE_MESSAGES.no_message_content,
  };
  assert.deepEqual(await loadSessionReplayLink(scope, deps([], result)), {
    state: "unavailable",
    message: NOT_REPLAYABLE_MESSAGES.no_message_content,
  });
});

test("the sandbox page opens a chat sandbox's replay, and refuses a structured sandbox", async () => {
  const d = deps([], source(null, "docs-agent"));
  const ready = await loadSessionReplay(
    { projectId: "p", sessionId: "s1", sandbox: { id: "docs-agent", inputKind: "chat" } },
    d,
  );
  assert.deepEqual(ready.state === "ready" ? [ready.source.turns.length, ready.match] : null, [
    1,
    { sandboxId: "docs-agent", by: "agent_name" },
  ]);
  const structured = await loadSessionReplay(
    { projectId: "p", sessionId: "s1", sandbox: { id: "x", inputKind: "structured" } },
    d,
  );
  assert.deepEqual(structured, {
    state: "unavailable",
    sessionId: "s1",
    message: NOT_CHAT_MESSAGE,
  });
});
