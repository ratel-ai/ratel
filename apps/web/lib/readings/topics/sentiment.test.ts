import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAcknowledgement,
  isRetryRequest,
  isSentiment,
  lexiconSentiment,
  SENTIMENT_OPTIONS,
} from "@/lib/readings/topics/sentiment";

test("clear frustration reads negative", () => {
  for (const text of [
    "That's wrong, I asked for the Riverside schedule",
    "this is not what I asked",
    "the export still doesn't work",
    "It does not work for PO 12",
    "can you try again?",
    "That’s wrong",
  ]) {
    assert.equal(lexiconSentiment(text), "negative", text);
  }
});

test("clear thanks reads positive, and frustration beats thanks", () => {
  assert.equal(lexiconSentiment("Thanks! Now book the crane for Monday"), "positive");
  assert.equal(lexiconSentiment("perfect, that worked"), "positive");
  assert.equal(lexiconSentiment("thanks but that's wrong"), "negative");
});

test("again on its own reads negative unless the message thanks", () => {
  assert.equal(lexiconSentiment("check the delivery again"), "negative");
  assert.equal(lexiconSentiment("great, run it again for Northgate"), "positive");
});

test("a plain request is neutral, and words are matched whole", () => {
  assert.equal(lexiconSentiment("Is the L4 deck pour on track?"), "neutral");
  assert.equal(lexiconSentiment("greater than 4 inches of cover"), "neutral");
  assert.equal(lexiconSentiment("list the wrongful termination claims"), "neutral");
});

test("the decision engine chooses between the three readings", () => {
  assert.deepEqual(
    SENTIMENT_OPTIONS.map((o) => o.entryId),
    ["positive", "neutral", "negative"],
  );
  assert.equal(isSentiment("negative"), true);
  assert.equal(isSentiment("none"), false);
});

test("a closing thanks is an acknowledgement, never a topic; a question with thanks is not", () => {
  for (const text of [
    "ok thanks",
    "Perfect, thank you",
    "Thanks, that's what I needed",
    "Great, thanks!",
  ]) {
    assert.equal(isAcknowledgement(text), true, text);
  }
  assert.equal(isAcknowledgement("thanks, now book the crane for Monday"), false);
  assert.equal(isAcknowledgement("ok"), false, "no thanks in it");
});

test("a short request to try again is asking the last question again", () => {
  for (const text of [
    "Try again?",
    "Still nothing? Try once more.",
    "Can you check again?",
    "try again please",
    "Can you try that again?",
  ]) {
    assert.equal(isRetryRequest(text), true, text);
  }
  assert.equal(isRetryRequest("Is the deck pour on track?"), false);
  assert.equal(
    isRetryRequest(
      "Run the weekly report again for Northgate and send it to the owner rep with the schedule",
    ),
    false,
    "long: a new ask",
  );
});
