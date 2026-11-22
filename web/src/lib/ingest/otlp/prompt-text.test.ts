import assert from "node:assert/strict";
import { test } from "node:test";
import { isSystemPrompt, MAX_PROMPT_CHARS, promptOf } from "./prompt-text";

test("GenAI parts: the last user message wins", () => {
  const messages = [
    { role: "system", parts: [{ type: "text", content: "be terse" }] },
    { role: "user", parts: [{ type: "text", content: "first ask" }] },
    { role: "assistant", parts: [{ type: "tool_call", id: "1", name: "find_task" }] },
    { role: "user", parts: [{ type: "text", content: "close out release 4.2" }] },
  ];
  assert.equal(
    promptOf({ "gen_ai.input.messages": JSON.stringify(messages) }),
    "close out release 4.2",
  );
});

test("AI SDK messages, OpenInference input.value and flattened attributes", () => {
  assert.equal(
    promptOf({
      "ai.prompt.messages": JSON.stringify([
        { role: "user", content: [{ type: "text", text: "plan a sprint" }] },
      ]),
    }),
    "plan a sprint",
  );
  assert.equal(
    promptOf({
      "input.value": JSON.stringify({ messages: [{ role: "user", content: "onboard Dara" }] }),
    }),
    "onboard Dara",
  );
  assert.equal(
    promptOf({
      "llm.input_messages.0.message.role": "system",
      "llm.input_messages.0.message.content": "rules",
      "llm.input_messages.1.message.role": "user",
      "llm.input_messages.1.message.content": "weekly report please",
    }),
    "weekly report please",
  );
  assert.equal(
    promptOf({ "gen_ai.prompt.0.role": "user", "gen_ai.prompt.0.content": "legacy ask" }),
    "legacy ask",
  );
});

test("no captured content means no prompt; long prompts are capped", () => {
  assert.equal(promptOf({ "gen_ai.operation.name": "chat" }), null);
  assert.equal(promptOf({ "input.value": "plain text that is not a message list" }), null);
  const long = "x".repeat(MAX_PROMPT_CHARS + 50);
  assert.equal(
    promptOf({ "gen_ai.input.messages": JSON.stringify([{ role: "user", content: long }]) })
      ?.length,
    MAX_PROMPT_CHARS,
  );
});

test("isSystemPrompt tells a system's opening message from a person's", () => {
  for (const system of [
    "Background task task_1e27 (supervisor) is completed. Result: VERDICT: fail",
    '[Task state] {"tasks":[{"name":"supervisor","status":"pending"}]}',
    'You are the subagent "supervisor". Description: Autopilot plan reviewer.',
    "<task-notification><task-id>b1</task-id></task-notification>",
    "Task build-42 has completed with errors",
  ]) {
    assert.equal(isSystemPrompt(system), true, system);
  }
  for (const person of [
    "ciao mi dici gli icp",
    "Can you check the background task I started?",
    "You are great, thanks",
    "task: write a blog post",
  ]) {
    assert.equal(isSystemPrompt(person), false, person);
  }
});
