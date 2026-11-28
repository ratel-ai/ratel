import assert from "node:assert/strict";
import { test } from "node:test";
import { caseContentSchema, caseDetailsSchema, inputProblem, runInputOf } from "../domain/case";
import { caseFromTurn, recordedConversation, type TurnContent } from "../domain/from-turn";
import { content } from "./support";

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
    name: "Case from a turn",
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

test("the name of a case from a turn has no captured text", () => {
  const messages = [{ id: "1", role: "user" as const, text: "My SSN is 123-45-6789" }];
  assert.equal(caseFromTurn(turn({ messages }), new Set())?.name, "Case from a turn");
});

test("a tool that no sandbox can declare gives no fixture, and the lists have a limit", () => {
  const many = Array.from({ length: 300 }, (_, n) => call("refund_order", { n }, { ok: true }));
  const made = caseFromTurn(
    turn({
      messages: [
        ...Array.from({ length: 300 }, (_, n) => ({
          id: `e${n}`,
          role: "user" as const,
          text: `earlier ${n}`,
          earlier: true,
        })),
        { id: "x", role: "user", text: "now" },
      ],
      toolCalls: [call("Bash:git", {}, "ok"), call("x".repeat(65), {}, "ok"), ...many],
    }),
    new Set(),
  );
  assert.ok(made);
  assert.equal(caseContentSchema.safeParse(made.content).success, true);
  assert.equal(made.content.toolFixtures.length, 200);
  assert.ok(made.content.toolFixtures.every(({ tool }) => tool === "refund_order"));
  assert.equal(made.content.earlierTurns.length, 200);
  assert.equal(made.content.earlierTurns.at(-1)?.text, "earlier 299");
});

test("a repeated message stays in the earlier turns, and the answer is the recorded one", () => {
  const said = (role: "user" | "assistant", text: string) => ({ role, text });
  const made = caseFromTurn(
    turn({
      conversation: {
        earlier: [
          said("user", "delete order 1"),
          said("assistant", "Are you sure?"),
          said("user", "yes"),
          said("assistant", "Done."),
          said("user", "delete order 2"),
          said("assistant", "Are you sure?"),
        ],
        ask: "yes",
        answer: "Done.",
      },
    }),
    new Set(),
  );
  assert.equal(made?.content.earlierTurns.length, 6);
  assert.deepEqual(made?.content.input, { message: "yes" });
  assert.equal(made?.sourceOutput, "Done.");
});

test("the recorded conversation is the messages of the calls, with no message removed", () => {
  const payload = (messages: unknown[], output: unknown[] = []) => ({
    messages: [...messages, ...output],
  });
  const m = (role: string, content: string) => ({ role, content });
  const history = [
    m("user", "delete order 1"),
    m("assistant", "Are you sure?"),
    m("user", "yes"),
    m("assistant", "Done."),
    m("user", "delete order 2"),
    m("assistant", "Are you sure?"),
    m("user", "yes"),
  ];
  assert.deepEqual(
    recordedConversation([payload([...history, m("assistant", "Done.")])] as never),
    {
      earlier: history.slice(0, -1).map(({ role, content }) => ({ role, text: content })),
      ask: "yes",
      answer: "Done.",
    },
  );
  assert.equal(recordedConversation([]), null);
});

test("a row needs an input. The scorers are the eval's", () => {
  assert.equal(inputProblem(content()), null);
  assert.match(inputProblem(content({ input: null })) ?? "", /input/);
  assert.equal(
    Object.hasOwn(caseContentSchema.parse({ ...content(), scorers: [] }), "scorers"),
    false,
  );
});

test("a label is text", () => {
  assert.deepEqual(
    caseDetailsSchema.parse({ name: " x ", labels: ["task:refunds", "task:refunds"] }),
    { name: "x", labels: ["task:refunds"] },
  );
});

test("the earlier turns of a case go into the run input as messages, next to the value", () => {
  const turns = [
    { role: "user" as const, text: "hi" },
    { role: "assistant" as const, text: "hello" },
  ];
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  assert.deepEqual(runInputOf({ input: { message: "and now?" }, earlierTurns: turns }), {
    message: "and now?",
    messages,
  });
  assert.deepEqual(runInputOf({ input: "and now?", earlierTurns: turns }), {
    value: "and now?",
    messages,
  });
  assert.deepEqual(runInputOf({ input: [1], earlierTurns: turns }), { value: [1], messages });
  // An input that has messages already keeps them first: the case says the whole conversation.
  assert.deepEqual(
    runInputOf({ input: { messages: [{ role: "user", content: "x" }] }, earlierTurns: turns }),
    { value: { messages: [{ role: "user", content: "x" }] }, messages },
  );
  const plain = { message: "x" };
  assert.equal(runInputOf({ input: plain, earlierTurns: [] }), plain);
});
