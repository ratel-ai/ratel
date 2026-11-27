import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ChangeClassifier,
  decisionClassifier,
  engineClassifier,
  selectEvalsWithModel,
} from "./classify";
import type { EvalTarget } from "./select";
import { fixture } from "./test-support";

const TOOLS = ["lookup_order", "refund_order"];
const EVALS: EvalTarget[] = [
  { id: "e-refunds", name: "Refunds", tools: TOOLS, rows: [{ id: "r1", tools: TOOLS }] },
  {
    id: "e-status",
    name: "Order status",
    tools: ["lookup_order"],
    rows: [{ id: "s1", tools: ["lookup_order"] }],
  },
];

test("only the files the rule leaves unmapped go to the model, and its reading is used", async () => {
  const asked: string[] = [];
  const classify: ChangeClassifier = async (file) => {
    asked.push(file.path);
    return { kind: "tool", tool: "lookup_order", confidence: 0.9 };
  };
  const diff = fixture("refund-tool.diff") + fixture("unmapped-code.diff");
  const selection = await selectEvalsWithModel(
    { diff, tools: TOOLS, evals: EVALS, traces: [] },
    classify,
  );
  assert.deepEqual(asked, ["src/format.ts"]);
  assert.equal(selection.mode, "some");
  assert.deepEqual(selection.change.tools, ["lookup_order", "refund_order"]);
});

test("with no model, or a model that cannot tell, the rule's answer stands", async () => {
  const input = { diff: fixture("unmapped-code.diff"), tools: TOOLS, evals: EVALS, traces: [] };
  assert.equal((await selectEvalsWithModel(input, null)).mode, "all");
  assert.equal((await selectEvalsWithModel(input, async () => null)).mode, "all");
  const failing: ChangeClassifier = async () => {
    throw new Error("decision engine down");
  };
  assert.equal((await selectEvalsWithModel(input, failing)).mode, "all");
});

test("at most maxFiles files are asked about; the rest stay unmapped", async () => {
  let calls = 0;
  const diff = Array.from({ length: 5 }, (_, i) =>
    fixture("unmapped-code.diff").replaceAll("src/format.ts", `src/f${i}.ts`),
  ).join("");
  const selection = await selectEvalsWithModel(
    { diff, tools: TOOLS, evals: EVALS, traces: [] },
    async () => {
      calls += 1;
      return { kind: "outside", confidence: 0.99 };
    },
    { maxFiles: 3 },
  );
  assert.equal(calls, 3);
  assert.deepEqual(selection.change.unmapped, ["src/f3.ts", "src/f4.ts"]);
  assert.equal(selection.mode, "all");
});

type Asked = {
  input: string;
  instructions: string;
  options: readonly { id: string; does: string }[];
};

function fakeAsk(answer: { choice: string; confidence: number } | "refusal") {
  const asked: Asked[] = [];
  return {
    asked,
    ask: async (request: Asked) => {
      asked.push(request);
      return {
        answer:
          answer === "refusal"
            ? ("refusal" as const)
            : { ...answer, probabilities: { [answer.choice]: answer.confidence } },
        inputTokens: 120,
      };
    },
  };
}

const FILE = {
  path: "src/format.ts",
  added: ["  return `$${(cents / 100).toFixed(2)}`;"],
  removed: ["  return `$${cents / 100}`;"],
};

test("the decision engine is asked one closed question per file: a tool, outside, or shared", async () => {
  const fake = fakeAsk({ choice: "tool:refund_order", confidence: 0.92 });
  const classify = decisionClassifier(fake.ask);
  assert.deepEqual(await classify(FILE, TOOLS), {
    kind: "tool",
    tool: "refund_order",
    confidence: 0.92,
  });
  const [request] = fake.asked;
  assert.deepEqual(
    request.options.map((o) => o.id),
    ["tool:lookup_order", "tool:refund_order", "outside", "shared"],
  );
  assert.match(request.input, /^File: src\/format\.ts\n/);
  assert.match(request.input, /\+ {2}return `\$\$\{\(cents/);
});

test("an answer below the confidence floor, or a refusal, is no answer", async () => {
  assert.equal(
    await decisionClassifier(fakeAsk({ choice: "outside", confidence: 0.6 }).ask)(FILE, TOOLS),
    null,
  );
  assert.equal(await decisionClassifier(fakeAsk("refusal").ask)(FILE, TOOLS), null);
  assert.deepEqual(
    await decisionClassifier(fakeAsk({ choice: "outside", confidence: 0.85 }).ask)(FILE, TOOLS),
    { kind: "outside", confidence: 0.85 },
  );
});

test("a long change is cut before it is sent", async () => {
  const fake = fakeAsk({ choice: "shared", confidence: 0.9 });
  await decisionClassifier(fake.ask)({ ...FILE, added: Array(2000).fill("x".repeat(40)) }, TOOLS);
  assert.ok(fake.asked[0].input.length <= 4_100);
});

test("without a decision engine there is no classifier, and nothing calls out", () => {
  assert.equal(
    engineClassifier(() => null),
    null,
  );
});

test("with one, a file goes to its Decisions API as one choice question", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return Response.json({
      answers: [
        {
          type: "choice",
          name: "tool",
          choice: "tool:refund_order",
          confidence: 0.93,
          probabilities: [{ value: "tool:refund_order", probability: 0.93 }],
        },
      ],
      usage: { input_tokens: 150 },
    });
  }) as typeof fetch;
  const classify = engineClassifier(
    () => ({ name: "openai", apiKey: "sk-test", baseUrl: "https://decisions.test" }),
    fetchImpl,
  );
  assert.ok(classify);
  assert.deepEqual(await classify(FILE, TOOLS), {
    kind: "tool",
    tool: "refund_order",
    confidence: 0.93,
  });
  assert.deepEqual(urls, ["https://decisions.test/v1/decisions"]);
});
