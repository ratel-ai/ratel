// System-one ranking with Jev, called directly (ADR-0026), end to end.
//
// 1. BM25 alone is confidently wrong for a "charged twice" question.
// 2. BM25 retrieves, Jev reranks its candidates.
// 3. Jev ranks the whole catalog on its own.
// 4. What failure looks like: a reranker falls back, a standalone search throws.
//
// With TYPESAFE_API_KEY set it calls Jev; without it, a local stand-in that
// speaks Jev's wire format. For a catalog Ratel Cloud owns, see
// examples/cloud-tool-picker-ts instead — Cloud runs Jev behind its picker.
import { SystemOneError, ToolCatalog } from "@ratel-ai/sdk";
import { startLocalJev } from "./local-jev.js";
import { ids, QUERY, tools } from "./tools.js";

const local = process.env.TYPESAFE_API_KEY ? undefined : await startLocalJev();
if (local) process.env.TYPESAFE_API_KEY = "local-stand-in-key";
const systemOne = local ? { url: local.url } : {};
console.log(`jev: ${local ? `${local.url}  (local stand-in)` : "https://api.typesafe.ai"}\n`);
console.log(`query: "${QUERY}"\n`);

try {
  // 1. Baseline: lexical only. "charged" pulls the charge tools to the top.
  const bm25 = new ToolCatalog();
  await bm25.register(tools);
  console.log(`bm25               : ${ids(bm25.search(QUERY, 3))}`);
  const deep = bm25.search(QUERY, 20).map((h) => h.toolId);
  console.log(`  (bm25 ranks stripe_refund_payment #${deep.indexOf("stripe_refund_payment") + 1})`);

  // 2. Two stages: BM25 picks up to `depth` candidates, Jev reorders them.
  //    The reranker never adds a tool BM25 did not return.
  const reranked = new ToolCatalog({
    method: "bm25",
    reranker: { method: "systemOne", depth: 20 },
    systemOne,
  });
  await reranked.register(tools);
  console.log(`bm25 -> systemOne  : ${ids(await reranked.searchAsync(QUERY, 3))}`);

  //    Per call, the catalog's reranker can be switched off (or replaced).
  const off = await reranked.searchAsync(QUERY, 3, { reranker: null });
  console.log(`  reranker: null   : ${ids(off)}`);

  // 3. One stage: Jev ranks every tool in the catalog (a tournament above 150).
  const standalone = new ToolCatalog({ method: "systemOne", systemOne });
  await standalone.register(tools);
  console.log(`systemOne alone    : ${ids(await standalone.searchAsync(QUERY, 3))}`);

  // 4. Failure. Point both catalogs at a Jev that is not there.
  const down = { url: "http://127.0.0.1:9" };
  const fallback = new ToolCatalog({ reranker: { method: "systemOne" }, systemOne: down });
  await fallback.register(tools);
  console.log(`\njev down:`);
  console.log(`  as a reranker    : ${ids(await fallback.searchAsync(QUERY, 3))}   (BM25 order)`);

  const strict = new ToolCatalog({ method: "systemOne", systemOne: down });
  await strict.register(tools);
  try {
    await strict.searchAsync(QUERY, 3);
  } catch (error) {
    if (!(error instanceof SystemOneError)) throw error;
    console.log(`  standalone       : SystemOneError code=${error.code}`);
  }
} finally {
  await local?.close();
}
