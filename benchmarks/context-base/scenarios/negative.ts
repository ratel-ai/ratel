import type { Scenario } from "../lib/types.js";

export const negativeScenarios: Scenario[] = [
  {
    id: 21,
    query: "What's the weather today?",
    expectedTools: [],
    type: "negative",
    seed: 4001,
  },
  {
    id: 22,
    query: "Tell me a joke",
    expectedTools: [],
    type: "negative",
    seed: 4002,
  },
  {
    id: 23,
    query: "What's the capital of France?",
    expectedTools: [],
    type: "negative",
    seed: 4003,
  },
];
