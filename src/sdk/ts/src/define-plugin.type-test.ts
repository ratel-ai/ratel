import { definePlugin, type RankFn, type RetrieverPlugin } from "./index.js";

const rank: RankFn = (_query, candidates) => candidates.map(({ id }) => ({ id, score: 1 }));

// A plugin carries both functions (ADR-0028).
const full: RetrieverPlugin = definePlugin({ retrieve: rank, rerank: rank });
const rerank: RankFn = full.rerank;

// @ts-expect-error a plugin needs rerank too; a one-stage ranker is a plain RankFn
const retrieveOnly = definePlugin({ retrieve: rank });
// @ts-expect-error a plugin needs retrieve too
const rerankOnly = definePlugin({ rerank: rank });
// @ts-expect-error the fields are RankFns, not method names
const notAFunction = definePlugin({ retrieve: "bm25", rerank: rank });
// @ts-expect-error RetrieverPlugin's fields are required
const partial: RetrieverPlugin = { retrieve: rank };

void [rerank, retrieveOnly, rerankOnly, notAFunction, partial];
