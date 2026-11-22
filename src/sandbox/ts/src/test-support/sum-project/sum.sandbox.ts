import { sandbox } from "../../index.js";

// A plain function with no model, prompt or tools: run() can be any async code.

export interface SumInput {
  numbers: number[];
}

export const sumDefaults = { scale: 1 };

export default sandbox("sum-numbers", {
  params: {
    scale: sandbox.number(sumDefaults.scale, { min: 0, max: 100 }),
  },
  input: sandbox.structured<SumInput>({
    type: "object",
    required: ["numbers"],
    properties: { numbers: { type: "array", items: { type: "number" } } },
  }),
  output: sandbox.output<{ total: number }>({
    type: "object",
    required: ["total"],
    properties: { total: { type: "number" } },
  }),
  state: "run",
  image: sandbox.image({
    base: "node:22-slim",
    install: ["npm install"],
    copy: ["."],
    sidecars: [sandbox.postgres({ version: "16", seed: "db/seed.sql" }), sandbox.redis()],
    env: ["SUM_REGION"],
  }),
  defaults: sumDefaults,
  example: { numbers: [1, 2, 3.5] },
  run: async ({ input, params }) => {
    await Promise.resolve();
    return { total: input.numbers.reduce((a, b) => a + b, 0) * params.scale };
  },
});
