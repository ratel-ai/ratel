import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationMessages, ROLE_LABEL } from "./conversation";
import {
  attributeLabel,
  attributeValue,
  experimentLabel,
  humanEventName,
  logPresentation,
  salientAttributes,
} from "./logs";

test("experiment records read in plain words with no engine terms", () => {
  assert.equal(logPresentation("ratel.experiment.comparison").label, "Comparison");
  assert.match(
    logPresentation("ratel.experiment.comparison").description,
    /current and comparison variants/,
  );
  assert.equal(logPresentation("ratel.experiment.drop").tone, "danger");
  assert.equal(logPresentation("ratel.catalog.definition").label, "Catalog definition");
  assert.equal(humanEventName("ratel.experiment.custom_thing"), "Custom thing");
  for (const name of ["results", "comparison", "skip", "fallback", "drop", "outcome"]) {
    const { label, description } = logPresentation(`ratel.experiment.${name}`);
    assert.doesNotMatch(`${label} ${description}`, /\barm\b|shadow|jaccard|_/i, name);
  }
});

test("record attributes get names and readable values, identity keys stay out", () => {
  assert.equal(attributeLabel("ratel.experiment.agreement.top1"), "Same first pick");
  assert.equal(attributeLabel("ratel.experiment.agreement.jaccard_at_k"), "Agreement");
  assert.equal(attributeValue(true), "Yes");
  assert.equal(attributeValue(0.66666), "0.667");
  assert.deepEqual(
    salientAttributes({
      "ratel.experiment.arm": "candidate",
      "ratel.experiment.zeta": "z",
      "ratel.experiment.agreement.top1": false,
      "ratel.experiment.result_count": 5,
    }).map((attribute) => `${attribute.label}: ${attribute.value}`),
    ["Results: 5", "Same first pick: No", "Zeta: z"],
  );
  assert.equal(
    experimentLabel({ experimentName: "ranking-v2", experimentArm: "candidate" }),
    "ranking-v2 · candidate",
  );
  assert.equal(experimentLabel({ experimentName: null, experimentArm: " " }), null);
});

test("the conversation keeps each message once, where it first appeared", () => {
  const messages = conversationMessages([
    { id: "1:0", role: "user", text: "Where is order 1234?" },
    { id: "1:1", role: "assistant", text: "Let me look." },
    { id: "2:0", role: "user", text: "Where is order 1234? " },
    { id: "2:1", role: "assistant", text: "Let me look." },
    { id: "2:2", role: "assistant", text: "It shipped yesterday." },
  ]);
  assert.deepEqual(
    messages.map((message) => message.id),
    ["1:0", "1:1", "2:2"],
  );
  assert.equal(ROLE_LABEL.assistant, "Agent");
});
