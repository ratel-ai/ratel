import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeJson } from "../decode";
import { typedStepFixtures, typedStepRequest } from "./typed-steps";

test("typed step fixtures survive OTLP JSON decoding with their span relationships", () => {
  const fixtures = typedStepFixtures();
  assert.deepEqual(Object.keys(fixtures), ["ratel", "bareChat", "stema", "vibiz", "cato", "docs"]);
  for (const spans of Object.values(fixtures)) {
    const decoded = decodeJson(Buffer.from(JSON.stringify(typedStepRequest(spans))));
    assert.deepEqual(
      decoded.map((span) => [
        span.name,
        span.traceId,
        span.spanId,
        span.parentSpanId,
        span.attributes,
      ]),
      spans.map((span) => [
        span.name,
        span.traceId,
        span.spanId,
        span.parentSpanId,
        span.attributes,
      ]),
    );
  }
  assert.equal(fixtures.ratel[0].name, "invoke_agent cluster_intents");
  assert.notEqual(
    fixtures.ratel[0].attributes["gen_ai.agent.name"],
    fixtures.ratel[1].attributes["gen_ai.agent.name"],
  );
  assert.equal(fixtures.bareChat.length, 1);
  assert.ok(fixtures.stema.every((span) => !span.attributes["gen_ai.agent.name"]));
  assert.equal(new Set(fixtures.vibiz.map((span) => span.traceId)).size, 2);
  assert.ok(fixtures.vibiz.every((span) => span.attributes["gen_ai.conversation.id"]));
  assert.ok(fixtures.cato.every((span) => !span.attributes["gen_ai.input.messages"]));
});
