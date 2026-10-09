// OpenAI's Decisions API as a retriever and a reranker through the SDK's
// ranking-function hooks (ADR-0027), end to end.
//
// 1. BM25 alone is confidently wrong for a "charged twice" question.
// 2. BM25 retrieves, Decisions reranks its candidates (`rerankerFn`).
// 3. Decisions ranks the whole catalog on its own (`method: "custom"`, `retrieveFn`).
// 4. What failure looks like: a reranker falls back, a retriever throws.
//
// Making the first plugin prints a one-time beta warning. With OPENAI_API_KEY
// set it calls OpenAI; without it, a local stand-in that speaks the Decisions
// wire format.
import { RetrieverError, ratelOpenAIDecisionPlugin, ToolCatalog } from "@ratel-ai/sdk";
import { startLocalDecisions } from "./local-openai-decision.js";
import { ids, QUERY, tools } from "./tools.js";

const local = process.env.OPENAI_API_KEY ? undefined : await startLocalDecisions();
if (local) process.env.OPENAI_API_KEY = "local-stand-in-key";
const decision = ratelOpenAIDecisionPlugin(local ? { url: local.url } : {});
console.log(
  `\ndecisions: ${local ? `${local.url}  (local stand-in)` : "https://api.openai.com"}\n`,
);
console.log(`query: "${QUERY}"\n`);

try {
  // 1. Baseline: lexical only. "charged" pulls the charge tools to the top.
  const bm25 = new ToolCatalog();
  await bm25.register(tools);
  console.log(`bm25                : ${ids(bm25.search(QUERY, 3))}`);
  const deep = bm25.search(QUERY, 20).map((h) => h.toolId);
  console.log(`  (bm25 ranks stripe_refund_payment #${deep.indexOf("stripe_refund_payment") + 1})`);

  // 2. Two stages: BM25 picks up to `rerankerDepth` candidates, Decisions
  //    reorders them. A reranker never adds a tool BM25 did not return.
  const reranked = new ToolCatalog({
    method: "bm25",
    rerankerFn: decision.rerank,
    rerankerDepth: 20,
  });
  await reranked.register(tools);
  console.log(`bm25 -> decisions   : ${ids(await reranked.searchAsync(QUERY, 3))}`);

  // 3. One stage: Decisions ranks every tool (a tournament above 150).
  const standalone = new ToolCatalog({ method: "custom", retrieveFn: decision.retrieve });
  await standalone.register(tools);
  console.log(`decisions alone     : ${ids(await standalone.searchAsync(QUERY, 3))}`);

  // 4. Failure. Point the plugin at an endpoint that is not there.
  const down = ratelOpenAIDecisionPlugin({ url: "http://127.0.0.1:9" });
  const fallback = new ToolCatalog({ rerankerFn: down.rerank });
  await fallback.register(tools);
  console.log(`\ndecisions down:`);
  console.log(`  as a reranker     : ${ids(await fallback.searchAsync(QUERY, 3))}   (BM25 order)`);

  const strict = new ToolCatalog({ method: "custom", retrieveFn: down.retrieve });
  await strict.register(tools);
  try {
    await strict.searchAsync(QUERY, 3);
  } catch (error) {
    if (!(error instanceof RetrieverError)) throw error;
    console.log(`  as the retriever  : RetrieverError code=${error.code} transient=${error.transient}`);
  }
} finally {
  await local?.close();
}
