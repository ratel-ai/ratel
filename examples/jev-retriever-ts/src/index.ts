// Jev as a retriever and a reranker through the SDK's ranking-function hooks
// (ADR-0027), end to end.
//
// 1. BM25 alone is confidently wrong for a "charged twice" question.
// 2. BM25 retrieves, Jev reranks its candidates (`rerankerFn`).
// 3. Jev ranks the whole catalog on its own (`method: "custom"`, `retrieveFn`).
// 4. Any ranking function works: a plain one you write yourself.
// 5. What failure looks like: a reranker falls back, a retriever throws.
//
// With TYPESAFE_API_KEY set it calls Jev; without it, a local stand-in that
// speaks Jev's wire format.
import { type RankFn, RetrieverError, ratelJevPlugin, ToolCatalog } from "@ratel-ai/sdk";
import { startLocalJev } from "./local-jev.js";
import { ids, QUERY, tools } from "./tools.js";

const local = process.env.TYPESAFE_API_KEY ? undefined : await startLocalJev();
if (local) process.env.TYPESAFE_API_KEY = "local-stand-in-key";
const jev = ratelJevPlugin(local ? { url: local.url } : {});
console.log(`jev: ${local ? `${local.url}  (local stand-in)` : "https://api.typesafe.ai"}\n`);
console.log(`query: "${QUERY}"\n`);

try {
  // 1. Baseline: lexical only. "charged" pulls the charge tools to the top.
  const bm25 = new ToolCatalog();
  await bm25.register(tools);
  console.log(`bm25                : ${ids(bm25.search(QUERY, 3))}`);
  const deep = bm25.search(QUERY, 20).map((h) => h.toolId);
  console.log(`  (bm25 ranks stripe_refund_payment #${deep.indexOf("stripe_refund_payment") + 1})`);

  // 2. Two stages: BM25 picks up to `rerankerDepth` candidates, Jev reorders
  //    them. A reranker never adds a tool BM25 did not return.
  const reranked = new ToolCatalog({ method: "bm25", rerankerFn: jev.rerank, rerankerDepth: 20 });
  await reranked.register(tools);
  console.log(`bm25 -> jev         : ${ids(await reranked.searchAsync(QUERY, 3))}`);

  //    Per call, the catalog's reranker can be switched off.
  const off = await reranked.searchAsync(QUERY, 3, { reranker: null });
  console.log(`  reranker: null    : ${ids(off)}`);

  // 3. One stage: Jev ranks every tool in the catalog (a tournament above 150).
  const standalone = new ToolCatalog({ method: "custom", retrieveFn: jev.retrieve });
  await standalone.register(tools);
  console.log(`jev alone           : ${ids(await standalone.searchAsync(QUERY, 3))}`);

  // 4. The hooks take any function: here, a keyword rule you could swap for
  //    any model you call yourself.
  const refundsFirst: RankFn = (query, candidates) =>
    candidates.map((c) => ({
      id: c.id,
      score: /money back|refund/.test(query) && c.text.includes("Return funds") ? 1 : 0,
    }));
  const custom = new ToolCatalog({ rerankerFn: refundsFirst });
  await custom.register(tools);
  console.log(`bm25 -> your fn     : ${ids(await custom.searchAsync(QUERY, 3))}`);

  // 5. Failure. Point the plugin at a Jev that is not there.
  const down = ratelJevPlugin({ url: "http://127.0.0.1:9" });
  const fallback = new ToolCatalog({ rerankerFn: down.rerank });
  await fallback.register(tools);
  console.log(`\njev down:`);
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
