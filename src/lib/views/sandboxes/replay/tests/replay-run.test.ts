import assert from "node:assert/strict";
import { test } from "node:test";
import { argsKey, type FakeLedger, type RecordedCall } from "../../fakes/domain/fake";
import type { FakeRunContext, FakeStore, PinInput } from "../../fakes/ports/fake-store";
import { createFakeService } from "../../fakes/service";
import { initialRunView, type RunViewState } from "../../playground-state";
import type { ReplayArm } from "../../replay";
import { type ReplayRunBody, type ReplayRunPorts, runSessionReplay } from "../replay-run";
import type { ReplayTurn } from "../session-source";
import type { ReplayArmTurn } from "../turn-compare";

/**
 * The session replay loop with in-memory ports and the real fake service: both
 * arms run in one session, so a pin on that session answers both; a pin wins
 * over the recorded match; each arm builds on its own replies.
 */

const PROJECT = "project-1";
const TURNS: ReplayTurn[] = [
  {
    turnIndex: 0,
    traceId: "t1",
    userMessage: "How do I make a key?",
    toolCalls: [
      {
        tool: "searchDocs",
        args: { query: "keys" },
        result: { hits: ["recorded"] },
        isError: false,
      },
    ],
  },
  { turnIndex: 1, traceId: "t2", userMessage: "And rotate it?", toolCalls: [] },
];

/** Pins per session and the replay source's recorded calls, like the Postgres store. */
class MemoryFakeStore implements FakeStore {
  runs = new Map<string, FakeRunContext>();
  pinsBySession = new Map<string, Map<string, PinInput>>();
  recorded: RecordedCall[] = [
    { args: { query: "keys" }, result: { hits: ["recorded"] }, isError: false },
  ];

  async runContext(runId: string) {
    return this.runs.get(runId) ?? null;
  }
  async sessionOwner() {
    return { projectId: PROJECT, ownerUserId: "me" };
  }
  async pinned(sessionId: string, tool: string, key: string) {
    const pin = this.pinsBySession.get(sessionId)?.get(`${tool}|${key}`);
    return pin ? { result: pin.result, isError: pin.isError } : null;
  }
  async pin(input: PinInput) {
    const pins = this.pinsBySession.get(input.sessionId) ?? new Map<string, PinInput>();
    pins.set(`${input.tool}|${input.argsKey}`, input);
    this.pinsBySession.set(input.sessionId, pins);
  }
  async pins() {
    return [];
  }
  async unpin() {
    return false;
  }
  async recordedCalls(query: { replay: FakeRunContext["replay"] }) {
    return query.replay?.sourceSessionId === "source-1" ? this.recorded : [];
  }
  async productionExamples() {
    return [];
  }
  async ledger(): Promise<FakeLedger> {
    return {};
  }
  async saveLedger() {}
  async countGenerated() {
    return 1;
  }
}

/** A runner whose agent calls searchDocs({query:"keys"}) on the first turn and replies with the arm and the tool result. */
function harness() {
  const store = new MemoryFakeStore();
  const service = createFakeService({
    store,
    model: { generate: async () => ({ result: { generated: true }, state: {}, isError: false }) },
    alerts: { capReached: () => {} },
    dailyCap: 10,
  });
  const bodies: ReplayRunBody[] = [];
  const rows: { baseline: Partial<ReplayArmTurn>; candidate: Partial<ReplayArmTurn> }[] = TURNS.map(
    () => ({ baseline: {}, candidate: {} }),
  );
  let runs = 0;
  let sessions = 0;
  const ports: ReplayRunPorts = {
    async startRun(body) {
      bodies.push(body);
      const runId = `run-${(runs += 1)}`;
      const sessionId = body.sessionId ?? `session-${(sessions += 1)}`;
      store.runs.set(runId, {
        runId,
        projectId: PROJECT,
        organizationId: null,
        sessionId,
        input: body.input,
        replay: { sourceSessionId: body.replay.sourceSessionId },
      });
      return { runId, sessionId };
    },
    async followRun(runId) {
      const context = store.runs.get(runId)!;
      const first = (context.input as ReplayRunBody["input"]).messages.length === 1;
      const tools: RunViewState["tools"] = [];
      if (first) {
        const outcome = await service.answer({
          runId,
          callId: "c1",
          tool: "searchDocs",
          args: { query: "keys" },
        });
        assert.equal(outcome.kind, "answer");
        if (outcome.kind === "answer")
          tools.push({
            callId: "c1",
            tool: "searchDocs",
            args: { query: "keys" },
            mode: "fake",
            result: outcome.answer.result,
            isError: outcome.answer.isError,
            fakeSource: outcome.answer.source,
            done: true,
          });
      }
      const arm = bodies.find((b) => store.runs.get(runId)!.input === b.input)!.replay.arm;
      return {
        ...initialRunView,
        phase: "ended",
        runId,
        status: "ok",
        text: `${arm} reply ${runId}`,
        tools,
      };
    },
    update(index: number, arm: ReplayArm, patch: Partial<ReplayArmTurn>) {
      rows[index]![arm] = { ...rows[index]![arm], ...patch };
    },
    onSession() {},
    stopped: () => false,
  };
  const request = {
    runnerId: "r",
    sandboxId: "docs-agent",
    sourceSessionId: "source-1",
    turns: TURNS,
    compare: true,
    candidateParams: { system: "edited" },
    changed: ["system"],
    toolModes: { searchDocs: "fake" as const },
  };
  return { store, ports, rows, bodies, request };
}

test("the first run answers both arms with the recorded match; a pin on the session then answers both arms, over the recorded match", async () => {
  const { store, ports, rows, request } = harness();
  const first = await runSessionReplay(request, ports);
  assert.equal(first.sessionId, "session-1");
  for (const arm of ["baseline", "candidate"] as const) {
    assert.deepEqual(
      rows[0]![arm].calls?.map((c) => [c.fakeSource, c.result]),
      [["recorded", { hits: ["recorded"] }]],
    );
  }

  await store.pin({
    sessionId: "session-1",
    tool: "searchDocs",
    argsKey: argsKey({ query: "keys" }),
    result: { hits: ["pinned"] },
    isError: false,
    pinnedBy: "me",
  });
  const again = await runSessionReplay({ ...request, sessionId: first.sessionId }, ports);
  assert.equal(again.sessionId, "session-1");
  for (const arm of ["baseline", "candidate"] as const) {
    assert.deepEqual(
      rows[0]![arm].calls?.map((c) => [c.fakeSource, c.result]),
      [["pinned", { hits: ["pinned"] }]],
    );
  }
});

test("both arms send the same recorded messages and tool modes, each with its own reply history", async () => {
  const { ports, bodies, request } = harness();
  await runSessionReplay(request, ports);
  assert.deepEqual(
    bodies.map((b) => [b.replay.arm, b.params, b.sessionId ?? null]),
    [
      ["baseline", {}, null],
      ["candidate", { system: "edited" }, "session-1"],
      ["baseline", {}, "session-1"],
      ["candidate", { system: "edited" }, "session-1"],
    ],
  );
  assert.ok(
    bodies.every(
      (b) => b.toolModes.searchDocs === "fake" && b.replay.sourceSessionId === "source-1",
    ),
  );
  const second = bodies.slice(2).map((b) => b.input.messages);
  assert.deepEqual(second[0], [
    { role: "user", content: "How do I make a key?" },
    { role: "assistant", content: "baseline reply run-1" },
    { role: "user", content: "And rotate it?" },
  ]);
  assert.deepEqual(second[1]![1], { role: "assistant", content: "candidate reply run-2" });
});

test("a pin in another session never answers this replay", async () => {
  const { store, ports, rows, request } = harness();
  await store.pin({
    sessionId: "session-other",
    tool: "searchDocs",
    argsKey: argsKey({ query: "keys" }),
    result: { hits: ["elsewhere"] },
    isError: false,
    pinnedBy: "me",
  });
  await runSessionReplay(request, ports);
  assert.equal(rows[0]!.candidate.calls?.[0]?.fakeSource, "recorded");
});
