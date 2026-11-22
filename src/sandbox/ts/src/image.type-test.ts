import { sandbox } from "./index.js";

// Compile-time checks of the output declaration (tsconfig.type-tests.json).

const input = sandbox.structured<{ numbers: number[] }>({ type: "object" });
const totalOutput = sandbox.output<{ total: number }>({ type: "object" });

// run() returns the declared output type: compiles.
sandbox("sum-ok", {
  params: {},
  input,
  output: totalOutput,
  run: async ({ input: i }) => ({ total: i.numbers.reduce((a, b) => a + b, 0) }),
});

sandbox("sum-wrong", {
  params: {},
  input,
  // @ts-expect-error run() returns a string, the output declares { total: number }
  output: totalOutput,
  run: async () => "not a total",
});

// A copy of a sandbox can change run() and its return type.
const base = sandbox("copy", { params: {}, input, output: totalOutput, run: () => ({ total: 1 }) });
sandbox("copy-2", { ...base, run: () => "text" });
