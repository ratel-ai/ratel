import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalProblem, caseContentSchema, caseDetailsSchema } from "../domain/case";
import { caseFromTurn, type TurnContent } from "../domain/from-turn";
import { content, NO_REFUND } from "./support";

const call = (name: string, args: unknown, result: unknown, earlier = false) => ({
  id: `${name}-${JSON.stringify(args)}`,
  name,
  arguments: args,
  result,
  spanId: "s",
  durationMs: 1,
  statusCode: 0,
  ...(earlier ? { earlier } : {}),
});
const turn = (over: Partial<TurnContent> = {}): TurnContent => ({
  ask: null,
  messages: [
    { id: "0", role: "system", text: "be kind" },
    { id: "1", role: "user", text: "hi", earlier: true },
    { id: "2", role: "assistant", text: "hello", earlier: true },
    { id: "3", role: "user", text: "refund A200" },
    { id: "4", role: "assistant", text: "Refunded." },
  ],
  toolCalls: [
    call("refund_order", { order_id: "A1" }, { ok: true }, true),
    call("lookup_order", { order_id: "A200" }, { days: 95 }),
    call("refund_order", { order_id: "A200" }, { status: "refunded" }),
    call("send_mail", { to: "x" }, null),
  ],
  ...over,
});

test("a turn gives the input, the earlier turns, the recorded answer and the side-effect fixtures", () => {
  assert.deepEqual(caseFromTurn(turn(), new Set(["lookup_order"])), {
    name: "refund A200",
    content: {
      input: { message: "refund A200" },
      earlierTurns: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
      toolFixtures: [
        {
          tool: "refund_order",
          arguments: { order_id: "A200" },
          result: { status: "refunded" },
        },
      ],
      expectedOutput: null,
      scorers: [],
    },
    sourceOutput: "Refunded.",
  });
});

test("a tool that no sandbox declares counts as one with side effects", () => {
  const made = caseFromTurn(turn(), new Set());
  assert.deepEqual(
    made?.content.toolFixtures.map(({ tool }) => tool),
    ["lookup_order", "refund_order"],
  );
});

test("the recorded JSON input of a sandbox run stays JSON", () => {
  const messages = [{ id: "1", role: "user" as const, text: '{"message":"x","n":1}' }];
  assert.deepEqual(caseFromTurn(turn({ messages }), new Set())?.content.input, {
    message: "x",
    n: 1,
  });
});

test("a turn with no message uses its ask, and a turn with no captured input gives no case", () => {
  assert.deepEqual(
    caseFromTurn(turn({ messages: [], ask: "where is A100" }), new Set())?.content.input,
    { message: "where is A100" },
  );
  assert.equal(caseFromTurn(turn({ messages: [] }), new Set()), null);
});

test("a long message gives a short name", () => {
  const messages = [{ id: "1", role: "user" as const, text: "word ".repeat(100) }];
  assert.ok((caseFromTurn(turn({ messages }), new Set())?.name.length ?? 999) <= 80);
});

test("the content accepts the shared scorer definitions with the paths of a trial only", () => {
  const check = (config: object) =>
    caseContentSchema.safeParse(
      content({
        // biome-ignore lint/suspicious/noExplicitAny: a wrong config is the point
        scorers: [{ ...NO_REFUND, definition: { kind: "check", config: config as any } }],
      }),
    ).success;
  for (const path of [
    "output",
    "output.status",
    "tools",
    "duration_ms",
    "cost_usd",
    "tool_arguments.refund_order.order_id",
  ]) {
    assert.ok(check({ path, op: "eq", value: "1" }), path);
  }
  for (const path of ["attributes.x", "models", "tool_arguments.refund_order", "output.", "x"]) {
    assert.ok(!check({ path, op: "eq", value: "1" }), path);
  }
  assert.ok(check({ path: "output", op: "exists" }));
  assert.ok(!check({ path: "output", op: "eq" }));
  assert.ok(!check({ path: "cost_usd", op: "lt", value: "cheap" }));
  const judge = (output: string) =>
    caseContentSchema.safeParse({
      ...content(),
      scorers: [
        { ...NO_REFUND, definition: { kind: "judge", config: { prompt: "polite?", output } } },
      ],
    }).success;
  assert.ok(judge("boolean"));
  assert.ok(!judge("numeric"));
});

test("an approval needs an input and one gating scorer", () => {
  assert.equal(approvalProblem(content()), null);
  assert.match(approvalProblem(content({ input: null })) ?? "", /input/);
  assert.match(
    approvalProblem(content({ scorers: [{ ...NO_REFUND, gating: false }] })) ?? "",
    /gating/,
  );
});

test("a label is text", () => {
  assert.deepEqual(
    caseDetailsSchema.parse({ name: " x ", labels: ["task:refunds", "task:refunds"] }),
    { name: "x", labels: ["task:refunds"] },
  );
});
