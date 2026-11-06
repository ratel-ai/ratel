import assert from "node:assert/strict";
import { test } from "node:test";
import type { TopicFlows } from "@/lib/readings/topics/types";
import {
  flowsGap,
  flowsNote,
  intentSentimentRead,
  sentimentHowRead,
} from "@/lib/views/intents/topics-explain";

const flows = (sessions: number, multiTurn: number): TopicFlows => ({
  all: { sessions, multiTurn, wentOn: 0, columns: [] },
  starts: [],
  byStart: {},
});

test("sentiment says on how many asks it was read, and whether a model or the keyword list read them", () => {
  assert.equal(
    sentimentHowRead({ measured: 1_439, of: 1_439, model: 1_439 }),
    "Read on 1,439 of 1,439 asks, by a model.",
  );
  assert.equal(
    sentimentHowRead({ measured: 60, of: 120, model: 0 }),
    "Read on 60 of 120 asks, by a keyword list.",
  );
  assert.equal(
    sentimentHowRead({ measured: 1_439, of: 1_439, model: 1_224 }),
    "Read on 1,439 of 1,439 asks: 1,224 by a model, 215 by a keyword list.",
  );
  assert.equal(
    sentimentHowRead({ measured: 60, of: 120, model: null }),
    "Read on 60 of 120 asks.",
    "an older reading did not keep how",
  );
  assert.match(
    sentimentHowRead({ measured: 0, of: 3_273, model: 0 }),
    /^Read on none of 3,273 asks: it needs people's own messages/,
  );
  assert.equal(intentSentimentRead(58, 60), "Read on 58 of 60 asks.");
});

test("Flows says plainly why it can't follow conversations, and what to send, per lane", () => {
  const sdkMixed = flowsGap({
    flows: null,
    lanes: { telemetry: 0, sdk: 300, telemetryWithoutConversation: 0 },
  })!;
  assert.equal(sdkMixed.title, "Can't follow conversations yet");
  assert.match(sdkMixed.body, /One session holds several people's asks/);
  assert.match(sdkMixed.body, /end-user id/);
  const otelShared = flowsGap({
    flows: null,
    lanes: { telemetry: 300, sdk: 0, telemetryWithoutConversation: 0 },
  })!;
  assert.match(otelShared.body, /One conversation id holds several people's asks at once/);
  assert.match(
    flowsGap({ flows: null, lanes: null })!.body,
    /session/,
    "an older reading reads as the SDK's case",
  );

  const alone = flowsGap({
    flows: flows(60, 0),
    lanes: { telemetry: 60, sdk: 0, telemetryWithoutConversation: 60 },
  })!;
  assert.equal(alone.title, "Every ask stands alone");
  assert.match(alone.body, /gen_ai\.conversation\.id/);
  const oneAskSessions = flowsGap({
    flows: flows(40, 0),
    lanes: { telemetry: 0, sdk: 40, telemetryWithoutConversation: 0 },
  })!;
  assert.equal(oneAskSessions.title, "Every session holds one ask");
  assert.equal(flowsGap({ flows: flows(40, 0), lanes: null })!.title, "No second asks yet");

  assert.equal(
    flowsGap({
      flows: flows(900, 350),
      lanes: { telemetry: 1_439, sdk: 0, telemetryWithoutConversation: 0 },
    }),
    null,
    "telemetry with conversation ids draws",
  );
  assert.equal(
    flowsGap({
      flows: flows(2_051, 647),
      lanes: { telemetry: 0, sdk: 3_273, telemetryWithoutConversation: 0 },
    }),
    null,
    "the SDK with sessions and end users draws",
  );
});

test("a quiet note counts the telemetry runs that carried no conversation id", () => {
  assert.equal(
    flowsNote({ lanes: { telemetry: 100, sdk: 200, telemetryWithoutConversation: 60 } }),
    "60 runs carried no conversation id, so each counts as a conversation of one ask.",
  );
  assert.equal(
    flowsNote({ lanes: { telemetry: 1, sdk: 0, telemetryWithoutConversation: 1 } }),
    "1 run carried no conversation id, so it counts as a conversation of one ask.",
  );
  assert.equal(
    flowsNote({ lanes: { telemetry: 100, sdk: 0, telemetryWithoutConversation: 0 } }),
    null,
  );
  assert.equal(flowsNote({ lanes: null }), null);
});
