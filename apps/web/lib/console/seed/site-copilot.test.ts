import assert from "node:assert/strict";
import { test } from "node:test";
import { SITE_COPILOT_TOOLS, SITE_PROJECTS } from "@/lib/console/seed/site-copilot-catalog";
import {
  chatDedupeHash,
  renderSiteCopilotOtlp,
  SITE_COPILOT_MAX_BODY_BYTES,
  SITE_COPILOT_MAX_BODY_SPANS,
  type SiteOtlpResult,
} from "@/lib/console/seed/site-copilot-otlp";
import {
  planSiteCopilot,
  SITE_COPILOT_MAX_TURNS,
  type SitePlan,
  type SiteTurn,
} from "@/lib/console/seed/site-copilot-plan";
import { SITE_TOPICS } from "@/lib/console/seed/site-copilot-turns";
import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { deriveModelCalls } from "@/lib/ingest/otlp/derive-model-calls";
import { deriveToolInvocations } from "@/lib/ingest/otlp/derive-tools";
import { groupSpans } from "@/lib/ingest/otlp/group";
import { toRow } from "@/lib/ingest/otlp/reconstruct";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";

const ANCHOR = Date.UTC(2026, 9, 20, 15, 0, 0);
const DAY_MS = 86_400_000;

const plan = planSiteCopilot();
const rendered = renderSiteCopilotOtlp(plan, { anchorMs: ANCHOR });
const turns = plan.conversations.flatMap((c) => c.turns);
let decodedCache: DecodedSpan[][] | null = null;
const decoded = (): DecodedSpan[][] =>
  (decodedCache ??= rendered.batches.map((body) =>
    decodeOtlp("application/json", Buffer.from(JSON.stringify(body))),
  ));

/** Everything the plan says, without the clock: asks, tools, outcomes and the agent's words. */
function content(p: SitePlan): string {
  return JSON.stringify(
    p.conversations.map((c) => [
      c.id,
      c.userId,
      c.turns.map((t) => [
        t.kind,
        t.ask,
        t.calls.map((call) => [call.tool, call.outcome, call.say ?? null]),
        t.reply,
      ]),
    ]),
  );
}

test("the same seed plans the same conversations, and another seed plans others", () => {
  assert.deepEqual(planSiteCopilot(), plan);
  assert.notEqual(content(planSiteCopilot({ seed: 7 })), content(plan));
});

test("the same plan and anchor render byte-identical bodies", () => {
  const again = renderSiteCopilotOtlp(planSiteCopilot(), { anchorMs: ANCHOR });
  assert.equal(JSON.stringify(again.batches), JSON.stringify(rendered.batches));
  assert.deepEqual(again.chatSpans, rendered.chatSpans);
});

test("another anchor moves the clock and nothing else", () => {
  const later = renderSiteCopilotOtlp(plan, { anchorMs: ANCHOR + 3 * DAY_MS + 7 * 3_600_000 });
  assert.deepEqual(later.chatSpans, rendered.chatSpans, "ids hash the turn, not the time");
  assert.notEqual(later.window.endMs, rendered.window.endMs);
  const ids = (out: SiteOtlpResult) =>
    new Set(
      out.batches.flatMap((body) => JSON.stringify(body).match(/"traceId":"[0-9a-f]{32}"/g) ?? []),
    );
  assert.deepEqual(ids(later), ids(rendered));
});

test("about 1,500 turns in conversations of 1 to 6 turns, over 30 days ending before the anchor", () => {
  assert.equal(plan.stats.turns, 1_500);
  assert.equal(turns.length, 1_500);
  for (const conversation of plan.conversations) {
    assert.ok(
      conversation.turns.length >= 1 && conversation.turns.length <= SITE_COPILOT_MAX_TURNS,
      conversation.key,
    );
  }
  assert.ok(
    plan.conversations.filter((c) => c.turns.length > 1).length > 200,
    "plenty of multi-turn conversations",
  );
  assert.ok(rendered.window.endMs < ANCHOR, "every span ends before the anchor");
  assert.ok(rendered.window.startMs >= ANCHOR - 30 * DAY_MS - DAY_MS, "the window is 30 days");
  assert.ok(rendered.window.startMs <= ANCHOR - 28 * DAY_MS, "and filled from its start");
});

test("every topic is asked, in more than one phrasing", () => {
  for (const topic of SITE_TOPICS) {
    const asks = new Set(
      turns
        .filter((t) => t.kind === topic)
        .map((t) => t.ask.replace(/PO-26-\d+|RFI-\d+|CO-\d+/g, "#")),
    );
    assert.ok(asks.size >= 5, `${topic} has ${asks.size} distinct asks`);
  }
});

test("the planted tasks each run at least 10 times, in a stable order", () => {
  const cores = [
    ["get_purchase_order", "track_material_delivery"],
    ["get_project_schedule", "check_weather_delay"],
    ["get_project_info", "search_spec_book"],
    ["list_rfis", "get_rfi"],
    ["get_change_order", "estimate_change_order"],
    ["get_pay_application", "check_payment_status"],
    ["list_subcontractors", "get_subcontractor_compliance"],
    ["log_safety_incident", "notify_team"],
  ];
  for (const core of cores) {
    const runs = turns.filter((t) =>
      core.every((tool) => t.calls.some((call) => call.tool === tool)),
    );
    assert.ok(runs.length >= 10, `${core.join(" > ")}: ${runs.length} runs`);
    const inOrder = runs.filter((t) => {
      const first = core.map((tool) => t.calls.findIndex((call) => call.tool === tool));
      return first.every((at, i) => i === 0 || at > first[i - 1]!);
    });
    assert.ok(inOrder.length / runs.length > 0.95, `${core.join(" > ")} keeps its order`);
  }
});

test("the supplier tracking service times out or returns 503 often, and other tools fail too", () => {
  const tracks = turns
    .flatMap((t) => t.calls)
    .filter((call) => call.tool === "track_material_delivery");
  const failed = tracks.filter((call) => call.outcome === "error");
  const share = failed.length / tracks.length;
  assert.ok(
    share > 0.15 && share < 0.45,
    `track_material_delivery fails ${(share * 100).toFixed(0)} percent of calls`,
  );
  assert.ok(
    failed.some((call) => call.errorType === "timeout") &&
      failed.some((call) => call.errorType === "503"),
  );
  const otherFailures = new Set(
    Object.keys(plan.stats.failedCalls)
      .map((key) => key.split(" ")[0])
      .filter((tool) => tool !== "track_material_delivery"),
  );
  assert.ok(otherFailures.size >= 5, `other tools fail too: ${[...otherFailures].join(", ")}`);
});

test("the agent retries, switches and gives up after errors", () => {
  const { retry, switch: switched, gaveUp } = plan.stats.behaviors;
  assert.ok(retry >= 20 && switched >= 10 && gaveUp >= 20, JSON.stringify(plan.stats.behaviors));
});

test("replies plant the self-correction and look-alike phrases the product will look for", () => {
  const replies = turns.map((t) => t.reply);
  assert.ok(
    replies.some((r) => r.startsWith("I'm sorry, the supplier tracking service didn't respond")),
  );
  assert.ok(replies.some((r) => r.startsWith("You're absolutely right, I used the wrong date")));
  assert.ok(replies.some((r) => r.startsWith("Actually, I don't have the spec book for")));
  const refusals = turns.filter((t) => t.reply.startsWith("I'm sorry, but I can't"));
  const onTrack = turns.filter((t) => t.reply.startsWith("You're right on track"));
  assert.ok(refusals.length > 0 && onTrack.length > 0);
});

test("equipment rental and inspection booking have no tool that does the job", () => {
  const lookups = new Set(["get_project_info", "list_projects", "get_project_schedule"]);
  const unanswerable = turns.filter(
    (t) => t.kind === "equipment_rental" || t.kind === "inspection_booking",
  );
  assert.ok(unanswerable.length >= 40);
  for (const turn of unanswerable) {
    assert.equal(turn.outcome, "unanswerable");
    assert.ok(
      turn.calls.every((call) => lookups.has(call.tool)),
      turn.key,
    );
  }
  assert.ok(
    !SITE_COPILOT_TOOLS.some((tool) => /rent|inspection/.test(tool.id)),
    "no rental or inspection tool in the menu",
  );
});

test("follow-ups: try again, that's not right, thanks, and the same ask again", () => {
  const asks = (kind: SiteTurn["kind"]) => turns.filter((t) => t.kind === kind);
  assert.ok(
    asks("try_again").length >= 10 && asks("try_again").some((t) => t.ask === "Can you try again?"),
  );
  assert.ok(
    asks("correction").length >= 10 &&
      asks("correction").some((t) => t.ask.startsWith("That's not right")),
  );
  assert.ok(asks("thanks").some((t) => t.ask === "Thanks, perfect"));
  const again = asks("asked_again");
  assert.ok(again.length >= 10);
  for (const conversation of plan.conversations) {
    conversation.turns.forEach((turn, i) => {
      if (turn.kind === "try_again")
        assert.notEqual(conversation.turns[i - 1]?.outcome, "answered", turn.key);
    });
  }
});

test("the change order flow repeats: estimate, refine, then the schedule impact", () => {
  const flows = plan.conversations.filter((c) =>
    c.turns.some(
      (t, i) =>
        t.kind === "change_orders" &&
        c.turns[i + 1]?.kind === "change_order_refine" &&
        c.turns[i + 2]?.kind === "schedule_impact",
    ),
  );
  assert.ok(flows.length >= 5, `${flows.length} conversations run the whole flow`);
});

test("no em dashes anywhere in what is sent, and every project name appears", () => {
  const sent = JSON.stringify(rendered.batches);
  assert.ok(!sent.includes("\u2014"), "no em dash");
  assert.ok(SITE_PROJECTS.every((p) => sent.includes(p.name)));
});

test("bodies stay inside the route's limits and decode to what was planned", () => {
  assert.ok(rendered.batches.length > 1);
  for (const body of rendered.batches)
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < SITE_COPILOT_MAX_BODY_BYTES);
  const spans = decoded();
  for (const body of spans) assert.ok(body.length <= SITE_COPILOT_MAX_BODY_SPANS);
  const tools = spans.flatMap((body) => deriveToolInvocations(body));
  assert.equal(tools.length, plan.stats.toolCalls);
  assert.equal(
    tools.filter((row) => row.type === "invoke_error").length,
    turns.flatMap((t) => t.calls).filter((c) => c.outcome !== "ok").length,
  );
  assert.ok(
    tools.every((row) => row.sessionId.startsWith("conv_") && row.endUserId?.startsWith("usr_")),
  );
  const models = spans.flatMap((body) => deriveModelCalls(body));
  assert.equal(models.length, rendered.stats.chatSpans);
  const asks = new Set(turns.map((t) => t.ask.slice(0, 1_000)));
  assert.ok(
    models.every((row) => asks.has(String(row.payload.prompt))),
    "every model call carries its turn's ask as the prompt",
  );
});

test("each model call's events row is keyed the way the trace id backfill expects", () => {
  const body = decoded()[0]!;
  const byResponse = new Map(
    rendered.chatSpans.map((chat) => [chatDedupeHash(chat.responseId), chat]),
  );
  for (const call of groupSpans(body).slice(0, 25)) {
    const row = toRow("11111111-1111-4111-8111-111111111111", call);
    const chat = byResponse.get(row.event.dedupeHash!);
    assert.ok(chat, "the dedupe hash names a planned chat span");
    assert.equal(chat.traceId, call.anchor.traceId);
    assert.equal(chat.spanId, call.anchor.spanId);
    const messages = (row.event.payload as { messages: Array<{ role: string }> }).messages;
    assert.equal(
      messages.at(-1)?.role,
      "assistant",
      "the output (a tool call or the reply) closes the captured messages",
    );
  }
});
