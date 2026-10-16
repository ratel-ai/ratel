// @ratel-ai/rankers-plugin — decision-model rankers as retrieve/rerank plugins
// for @ratel-ai/sdk (ADR-0027, ADR-0028). The SDK owns the plugin contract;
// this package re-exports it so a plugin author imports from one place.

export type {
  RankCandidate,
  RankCandidateKind,
  RankedId,
  RankFn,
  RetrieverPlugin,
} from "@ratel-ai/sdk";
export { definePlugin, RetrieverError } from "@ratel-ai/sdk";
export type { ChoiceRanker } from "./adapter.js";
export { choiceRankerPlugin } from "./adapter.js";
export type { JevPluginConfig } from "./jev.js";
export { ratelJevPlugin } from "./jev.js";
export type { OpenAIDecisionPluginConfig } from "./openai-decision.js";
export { ratelOpenAIDecisionPlugin } from "./openai-decision.js";
