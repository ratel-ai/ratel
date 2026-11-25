import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPLY_QUESTION,
  replyContent,
  replyReactionByRule,
  replyReactionOf,
} from "@/lib/readings/trace-signals/outcomes/reply-reading";

test("a reply that concedes, apologises or admits says the person corrected the agent", () => {
  for (const reply of [
    "You're right, I stopped early. The other 7 are set to Friday now.",
    "Sorry about that. All six tasks are unassigned now.",
    "My mistake: I archived the active project. Restored it.",
    "Haklısınız. Dört görevi de Launch projesine taşıdım.",
    "Tienes razón, las fechas no debían estar.",
  ]) {
    assert.equal(replyReactionByRule(reply), "corrects", reply);
  }
});

test("a handoff says the person asked for a human; a welcome says they were satisfied; a retry that they asked again", () => {
  assert.equal(
    replyReactionByRule(
      "I've passed this conversation to our billing team. They will email you within a day.",
    ),
    "asks_human",
  );
  assert.equal(
    replyReactionByRule("You can reach our support team at support@example.com."),
    "asks_human",
  );
  assert.equal(replyReactionByRule("Talebinizi müşteri temsilcisine aktardım."), "asks_human");
  assert.equal(replyReactionByRule("You're welcome."), "satisfied");
  assert.equal(replyReactionByRule("Glad that's sorted."), "satisfied");
  assert.equal(replyReactionByRule("Let me try that again with the full list."), "repeats");
});

test("a reply that says nothing about the message it answers reads as nothing", () => {
  for (const reply of [
    'Restored "Onboarding v2" and archived "Onboarding 2024" instead.',
    'Created INF-90 "Renew the SSL cert" in Infra.',
    "Anything else?",
    "",
    null,
  ]) {
    assert.equal(replyReactionByRule(reply), null, String(reply));
  }
  // Sympathy is not an apology for the agent's own work.
  assert.equal(
    replyReactionByRule("I'm sorry to hear the release slipped. Here are the open tasks."),
    null,
  );
});

test("the reply question reads the work before and the reply; can't tell and abstentions read as nothing", () => {
  assert.equal(
    replyContent(
      [{ tool: "manage_project", outcome: "ok" }],
      "Restored v2 and archived the 2024 one instead.",
    ),
    "The agent did: manage_project (ok)\nThen the person sent a message. The agent replied: Restored v2 and archived the 2024 one instead.",
  );
  assert.deepEqual(
    REPLY_QUESTION.options?.map((option) => option.option),
    ["satisfied", "corrects", "repeats", "asks_human", "new_request", "cant_tell"],
  );
  assert.equal(replyReactionOf({ answer: "corrects", probability: 0.93 }), "corrects");
  assert.equal(replyReactionOf({ answer: "cant_tell", probability: 0.9 }), null);
  assert.equal(replyReactionOf({ answer: "unknown", probability: null }), null);
  assert.equal(replyReactionOf(undefined), null);
});
