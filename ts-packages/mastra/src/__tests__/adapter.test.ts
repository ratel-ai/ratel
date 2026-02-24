import { describe, it, expect } from "vitest";
import { Subject, firstValueFrom } from "rxjs";
import { take } from "rxjs/operators";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { AgentifiedMastraAdapter } from "../adapter.js";

function mockMastraAgent(stream: Subject<BaseEvent>) {
  return { run: () => stream.asObservable() } as any;
}

function makeRunInput(): RunAgentInput {
  return {
    threadId: "t1",
    runId: "r1",
    messages: [],
    tools: [],
    context: [],
  };
}

describe("AgentifiedMastraAdapter", () => {
  it("converts AgentifiedEvent to AG-UI CUSTOM event", async () => {
    const agentStream = new Subject<BaseEvent>();
    const adapter = new AgentifiedMastraAdapter({
      mastraAgent: mockMastraAgent(agentStream),
    });

    const collected = firstValueFrom(adapter.run(makeRunInput()).pipe(take(1)));

    adapter.onEvent({
      type: "agentified:prefetch:start",
      messages: [{ role: "user", content: "hello" }],
    });

    const event = await collected;
    expect(event).toEqual({
      type: "CUSTOM",
      name: "agentified:prefetch:start",
      value: {
        type: "agentified:prefetch:start",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    agentStream.complete();
  });

  it("merges MastraAgent events with Agentified events in run stream", async () => {
    const agentStream = new Subject<BaseEvent>();
    const adapter = new AgentifiedMastraAdapter({
      mastraAgent: mockMastraAgent(agentStream),
    });

    const collected: BaseEvent[] = [];
    const sub = adapter.run(makeRunInput()).subscribe((e) => collected.push(e));

    // Mastra agent emits a TEXT_MESSAGE_START
    agentStream.next({
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant",
    } as BaseEvent);

    // Agentified emits a discover event
    adapter.onEvent({
      type: "agentified:discover:start",
      query: "find tools",
    });

    // Mastra agent emits TEXT_MESSAGE_CONTENT
    agentStream.next({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "Hello",
    } as BaseEvent);

    agentStream.complete();
    sub.unsubscribe();

    expect(collected).toHaveLength(3);
    expect(collected[0]).toEqual({
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant",
    });
    expect(collected[1]).toEqual({
      type: "CUSTOM",
      name: "agentified:discover:start",
      value: { type: "agentified:discover:start", query: "find tools" },
    });
    expect(collected[2]).toEqual({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "Hello",
    });
  });

  it("delivers all four Agentified event types as CUSTOM events", async () => {
    const agentStream = new Subject<BaseEvent>();
    const adapter = new AgentifiedMastraAdapter({
      mastraAgent: mockMastraAgent(agentStream),
    });

    const collected: BaseEvent[] = [];
    const sub = adapter.run(makeRunInput()).subscribe((e) => collected.push(e));

    adapter.onEvent({ type: "agentified:prefetch:start", messages: [] });
    adapter.onEvent({
      type: "agentified:prefetch:complete",
      tools: [],
      durationMs: 42,
    });
    adapter.onEvent({ type: "agentified:discover:start", query: "test" });
    adapter.onEvent({
      type: "agentified:discover:complete",
      tools: [{ name: "t1", score: 0.9 }],
      durationMs: 15,
    });

    agentStream.complete();
    sub.unsubscribe();

    expect(collected).toHaveLength(4);
    const names = collected.map((e) => (e as any).name);
    expect(names).toEqual([
      "agentified:prefetch:start",
      "agentified:prefetch:complete",
      "agentified:discover:start",
      "agentified:discover:complete",
    ]);

    // Verify complete events carry durationMs through
    expect((collected[1] as any).value.durationMs).toBe(42);
    expect((collected[3] as any).value.tools).toEqual([
      { name: "t1", score: 0.9 },
    ]);
  });

  it("returns stable onEvent reference across accesses", () => {
    const agentStream = new Subject<BaseEvent>();
    const adapter = new AgentifiedMastraAdapter({
      mastraAgent: mockMastraAgent(agentStream),
    });

    const ref1 = adapter.onEvent;
    const ref2 = adapter.onEvent;
    expect(ref1).toBe(ref2);
  });
});
