import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CapturedReply,
  phraseCorrections,
  REPLY_BLOCK_SEPARATOR,
  replyExcerpt,
  replyTextOf,
} from "@/lib/readings/trace-signals/self-corrections/replies";
import { fresh, signalTurns } from "@/lib/readings/trace-signals/signals/test-fixtures";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const tool = (content: string) => ({ role: "tool", tool_call_id: "c1", content });
const assistant = (...blocks: unknown[]) => ({ role: "assistant", content: blocks });
const text = (value: string) => ({ type: "text", text: value });
const call = (name: string) => ({ type: "tool_call", id: "c1", name, arguments: {} });

test("the reply is the trailing assistant messages' text, tool calls skipped", () => {
  assert.equal(
    replyTextOf([
      user("find it"),
      assistant(text("I'm sorry, let me try that again."), call("find")),
    ]),
    "I'm sorry, let me try that again.",
  );
  assert.equal(
    replyTextOf([user("q"), assistant(text("First.")), assistant(text("Second."))]),
    `First.${REPLY_BLOCK_SEPARATOR}Second.`,
    "two trailing assistant messages are one reply, a paragraph apart",
  );
  assert.equal(
    replyTextOf([user("q"), { role: "assistant", content: "A bare string reply." }]),
    "A bare string reply.",
  );
});

test("an assistant message in the input is an earlier call's reply, never read again", () => {
  const history = [user("q"), assistant(text("My mistake, that was wrong.")), tool("result")];
  assert.equal(
    replyTextOf(history),
    null,
    "the call's input ends on a tool result and its output was not captured",
  );
  assert.equal(replyTextOf([...history, assistant(text("Done."))]), "Done.");
});

test("no reply: a tool call only, nothing captured, or a payload of another shape", () => {
  assert.equal(replyTextOf([user("q"), assistant(call("find"))]), null);
  assert.equal(replyTextOf([user("")]), null);
  assert.equal(replyTextOf([]), null);
  assert.equal(replyTextOf(null), null);
  assert.equal(replyTextOf({ messages: [] }), null);
  assert.equal(replyTextOf([user("q"), assistant(text("   "))]), null, "blank text is no reply");
  assert.equal(replyTextOf([user("q"), "garbage", 42]), null);
});

const at = (ms: number) => new Date(Date.parse("2026-09-01T09:00:00Z") + ms);

function reply(eventId: string, ms: number, value: string): CapturedReply {
  return { eventId, at: at(ms), text: value };
}

test("each phrase carries its reply, its range, and the tool call that started before the reply", () => {
  // Calls at +0 (find, fails) and +2s (find again); see the fixture's clock.
  const [turn] = signalTurns([
    fresh({ start: at(0) })
      .invoke("find")
      .error("find")
      .invoke("find"),
  ]);
  const steps = turn!.steps;
  const phrases = phraseCorrections(steps, [
    reply("e0", -500, "Sure, looking now."),
    reply("e1", 1_500, "Sorry about that, let me try that again."),
  ]);
  assert.deepEqual(
    phrases.map((p) => [
      p.phrase,
      p.category,
      p.sourceEventId,
      p.tool,
      p.toolOrdinal,
      p.toolOutcome,
    ]),
    [
      ["Sorry about that", "apology", "e1", "find", steps[0]!.ordinal, "error"],
      ["Let me try that again", "retry", "e1", "find", steps[0]!.ordinal, "error"],
    ],
  );
  assert.equal(
    "Sorry about that, let me try that again.".slice(phrases[1]!.start, phrases[1]!.end),
    "let me try that again",
  );
  assert.deepEqual(phrases[0]!.occurredAt, at(1_500));
});

test("a reply before any call has no tool; the same text read twice in a turn counts once", () => {
  const [turn] = signalTurns([fresh({ start: at(10_000) }).invoke("find")]);
  const phrases = phraseCorrections(turn!.steps, [
    reply("e2", 20_000, "You're absolutely right, my mistake."),
    reply("e1", 0, "You're absolutely right, my mistake."),
  ]);
  assert.deepEqual(
    phrases.map((p) => [p.phrase, p.sourceEventId, p.tool]),
    [
      ["You're absolutely right", "e1", null],
      ["My mistake", "e1", null],
    ],
  );
});

test("an excerpt: the phrase with words around it, cut at words, or null when the range no longer fits", () => {
  const reply =
    "I looked up the ticket. I'm sorry, the board was archived, so I could not move it.";
  const start = reply.indexOf("I'm sorry");
  assert.deepEqual(replyExcerpt(reply, start, start + 9), {
    before: "I looked up the ticket. ",
    phrase: "I'm sorry",
    after: ", the board was archived, so I could not move it.",
  });
  assert.deepEqual(replyExcerpt(reply, start, start + 9, 12), {
    before: "…ticket. ",
    phrase: "I'm sorry",
    after: ", the board…",
  });
  assert.equal(replyExcerpt(reply, start, reply.length + 1), null);
  assert.equal(replyExcerpt(reply, 5, 5), null);
  assert.equal(replyExcerpt(reply, -1, 3), null);
});
