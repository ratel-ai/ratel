import type { Scenario } from "../lib/types.js";

export const ambiguousScenarios: Scenario[] = [
  {
    id: 24,
    query: "Help me with Marco",
    expectedTools: [],
    type: "ambiguous",
    seed: 5001,
  },
  {
    id: 25,
    query: "There's a problem with Lisa's account",
    expectedTools: [],
    type: "ambiguous",
    seed: 5002,
    skip: true,
  },
];
