import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import type { ModelCall } from "@/lib/views/eval-gate/calls";
import type { RunRecord } from "@/lib/views/eval-gate/types";
import type { EvalReplay } from "../job";

/** The recorded turn the seat recording replays. */
export const TURN = "44444444-4444-4444-8444-444444444444";

/** `booking`: the reference the calls pass (RC-609: one the ask never shows is unseen). */
export function seatRecording(booking: { ref: string } = { ref: "R1" }): EvalReplay {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, n));
  const steps = [
    { name: "get_seat_map", args: { ...booking }, result: { free: ["23A"] } },
    { name: "select_seat", args: { ...booking, seat: "23A" }, result: { seat: "23A" } },
  ];
  const payload = (messages: CloudMessage[], finish: CloudEvent["finish_reason"]): CloudEvent => ({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    ts: at(0).toISOString(),
    system: "You are a travel agent.",
    tools: steps.map(({ name }) => ({
      name,
      description: `${name} does its job.`,
      parameters: { type: "object", properties: {} },
    })),
    messages,
    finish_reason: finish,
  });
  const conversation: CloudMessage[] = [
    { role: "user", content: [{ type: "text", text: "Pick seat 23A on R1" }] },
  ];
  const calls: ModelCall[] = [];
  steps.forEach((step, index) => {
    const output: CloudMessage = {
      role: "assistant",
      content: [{ type: "tool_call", id: `toolu_${index}`, name: step.name, arguments: step.args }],
    };
    calls.push({
      turnId: TURN,
      occurredAt: at(index * 2),
      model: "claude-sonnet-4-6",
      finishReason: "tool_call",
      costUsd: 0.003,
      latencyMs: 800,
      inputTokens: 900,
      outputTokens: 30,
      payload: payload([...conversation, output], "tool_call"),
    });
    conversation.push(output, {
      role: "tool",
      tool_call_id: `toolu_${index}`,
      content: JSON.stringify(step.result),
    });
  });
  const answer: CloudMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Seat 23A is yours." }],
  };
  calls.push({
    turnId: TURN,
    occurredAt: at(4),
    model: "claude-sonnet-4-6",
    finishReason: "stop",
    costUsd: 0.003,
    latencyMs: 800,
    inputTokens: 900,
    outputTokens: 30,
    payload: payload([...conversation, answer], "stop"),
  });
  const run: RunRecord = {
    turnId: TURN,
    traceId: "trace-1",
    startedAt: at(0).toISOString(),
    endedAt: at(4).toISOString(),
    taskId: "wf-1",
    steps: steps.map((step, index) => ({
      kind: "invoke",
      ordinal: index + 1,
      targetId: step.name,
      outcome: "ok",
    })),
    durationMs: 4000,
    costUsd: 0.009,
    answered: true,
  };
  return { run, calls };
}
