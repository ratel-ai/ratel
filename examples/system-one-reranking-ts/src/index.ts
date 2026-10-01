// System-one ranking and the two-stage reranker (ADR-0026), end to end.
//
// 1. BM25 alone is confidently wrong for a "charged twice" question.
// 2. BM25 retrieves, a system-one model reranks its candidates.
// 3. The system-one model ranks the whole catalog on its own.
// 4. What failure looks like: a reranker falls back, a standalone search throws.
//
// With no env vars it runs against a local stand-in endpoint (no key needed).
// Set RATEL_SYSTEM_ONE_URL (and RATEL_API_KEY) to call a real endpoint instead.
import { SystemOneError, ToolCatalog } from "@ratel-ai/sdk";
import { startMockSystemOne } from "./mock-system-one.js";
import { ids, QUERY, tools } from "./tools.js";

const KEY_ENV = "RATEL_API_KEY";
const realUrl = process.env.RATEL_SYSTEM_ONE_URL;
const mock = realUrl ? undefined : await startMockSystemOne();
if (mock) process.env[KEY_ENV] ??= "local-mock-key";
const systemOne = { url: realUrl ?? mock?.url, apiKeyEnv: KEY_ENV };
console.log(`system-one endpoint: ${systemOne.url}${mock ? "  (local stand-in)" : ""}\n`);
console.log(`query: "${QUERY}"\n`);

try {
  // 1. Baseline: lexical only. "charged" pulls the charge tools to the top.
  const bm25 = new ToolCatalog();
  await bm25.register(tools);
  console.log(`bm25               : ${ids(bm25.search(QUERY, 3))}`);
  const deep = bm25.search(QUERY, 20).map((h) => h.toolId);
  console.log(`  (bm25 ranks stripe_refund_payment #${deep.indexOf("stripe_refund_payment") + 1})`);

  // 2. Two stages: BM25 picks up to `depth` candidates, system-one reorders them.
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

  // 3. One stage: the system-one model ranks every tool in the catalog.
  const standalone = new ToolCatalog({ method: "systemOne", systemOne });
  await standalone.register(tools);
  console.log(`systemOne alone    : ${ids(await standalone.searchAsync(QUERY, 3))}`);

  // 4. Failure. Point both catalogs at an endpoint that is not there.
  const down = { url: "http://127.0.0.1:9/v1/systemone", apiKeyEnv: KEY_ENV };
  const fallback = new ToolCatalog({ reranker: { method: "systemOne" }, systemOne: down });
  await fallback.register(tools);
  console.log(`\nendpoint down:`);
  console.log(`  as a reranker    : ${ids(await fallback.searchAsync(QUERY, 3))}   (BM25 order)`);

  const strict = new ToolCatalog({ method: "systemOne", systemOne: down });
  await strict.register(tools);
  try {
    await strict.searchAsync(QUERY, 3);
  } catch (error) {
    if (!(error instanceof SystemOneError)) throw error;
    console.log(`  standalone       : SystemOneError code=${error.code}`);
  }

  if (mock) console.log(`\nstand-in endpoint served ${mock.requests} requests`);
} finally {
  await mock?.close();
}
