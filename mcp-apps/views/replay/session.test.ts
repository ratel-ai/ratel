import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionChat } from "@/lib/views/session-chat/model";
import redacted from "./captured/redacted.json";
import short from "./captured/short.json";
import { run } from "./fixtures";
import { initialPeek, peekContext, readSessionChatView } from "./session";

test("a result's view is read as the console's SessionChat; anything else is no session", () => {
  const view = readSessionChatView(short);
  assert.equal(view?.chat.sessionId, "replay-demo-session");
  assert.equal(view?.turnIndex, null);
  assert.match(view?.sessionHref ?? "", /\/sessions\/replay-demo-session$/);
  assert.equal(readSessionChatView({}), null, "a host that passed the text only");
  assert.equal(
    readSessionChatView({
      view: { kind: "session_chat", projectId: "p", chat: { sessionId: "s" } },
    }),
    null,
    "a chat without its turns",
  );
  assert.equal(
    readSessionChatView({ view: { kind: "trace", projectId: "p", chat: short.view.chat } }),
    null,
  );
});

test("a run opens on its own turn's work; a session opens with no panel", () => {
  assert.equal(initialPeek(readSessionChatView(run)!), "work:3");
  assert.equal(initialPeek(readSessionChatView(short)!), null);
  const missing = readSessionChatView(run)!;
  assert.equal(initialPeek({ ...missing, turnIndex: 99 }), null, "a turn the chat does not hold");
});

test("the model hears which step or turn is open, without message text", () => {
  const chat = readSessionChatView(short)!.chat as SessionChat;
  const call = chat.calls[0]!;
  const step = peekContext(chat, { kind: "step", stepIndex: call.stepIndex });
  assert.match(
    step?.text ?? "",
    new RegExp(
      `step ${call.stepIndex} of session replay-demo-session, in turn ${call.turnIndex}: Thinking`,
    ),
  );
  assert.equal(step?.structured.stepIndex, call.stepIndex);
  const ask = peekContext(chat, { kind: "ask", turnIndex: 1 });
  assert.equal(
    ask?.text,
    "The user is looking at the user's message in turn 1 of session replay-demo-session.",
  );
  assert.ok(!ask!.text.includes(chat.turns[0]!.ask ?? "\u0000"), "no message text in the context");
  assert.equal(peekContext(chat, { kind: "step", stepIndex: 9999 }), null);
});

test("the redacted fixture is the console's text-off chat: no asks, no replies", () => {
  const chat = readSessionChatView(redacted)!.chat;
  assert.equal(chat.textOff, true);
  assert.ok(chat.turns.every((turn) => turn.ask === null && turn.reply === null));
  assert.ok(
    readSessionChatView(short)!.chat.turns.some((turn) => turn.ask),
    "the opted-in fixture keeps its text",
  );
});
