// The Ratel Cloud Tool Picker (ADR-0027) on a cloud-owned catalog (ADR-0028).
//
// 1. Local BM25 is confidently wrong for a "charged twice" question.
// 2. `cloud` on ratel(): register syncs the catalog to Cloud.
// 3. searchAsync ranks through the Tool Picker, in each mode.
// 4. What failure looks like: a sync that only warns, a search that throws.
//
// With no env vars it runs against a local stand-in for Cloud (no key needed).
// Set RATEL_CLOUD_URL=https://cloud.ratel.sh and RATEL_API_KEY to use Cloud.
import { CloudError, ratel, ToolCatalog } from "@ratel-ai/sdk";
import { startLocalCloud } from "./local-cloud.js";
import { ids, QUERY, tools } from "./tools.js";

const realUrl = process.env.RATEL_CLOUD_URL;
const local = realUrl ? undefined : await startLocalCloud();
if (local) process.env.RATEL_API_KEY ??= "local-stand-in-key";
const url = realUrl ?? local?.url;
console.log(`ratel cloud: ${url}${local ? "  (local stand-in)" : ""}\n`);
console.log(`query: "${QUERY}"\n`);

try {
  // 1. Baseline: a local BM25 catalog. "charged" pulls the charge tools up.
  const bm25 = new ToolCatalog();
  await bm25.register(tools);
  console.log(`local bm25        : ${ids(bm25.search(QUERY, 3))}`);

  // 2. A cloud-owned catalog. register() resolves once Cloud has the catalog;
  //    executors stay here, only the executor-free definitions are uploaded.
  const r = ratel({ cloud: { url, mode: "precise", sourceId: "cloud-tool-picker-example" } });
  await r.tools.register(...tools);
  const again = await r.tools.catalog.syncNow();
  console.log(`synced            : ${again.tools} tools, version ${again.catalogVersion}`);
  console.log(`  re-sync         : skipped=${again.skipped} (nothing changed)\n`);

  // 3. Every search goes to the Tool Picker; the mode trades speed for accuracy.
  console.log(`cloud precise     : ${ids(await r.tools.searchAsync(QUERY, 3))}`);
  for (const mode of ["instant", "exhaustive"] as const) {
    const hits = await r.tools.catalog.searchAsync(QUERY, 3, { mode });
    console.log(`cloud ${mode.padEnd(11)} : ${ids(hits)}`);
  }

  // 4. Failure. A catalog pointed at a Cloud that is not there.
  const down = new ToolCatalog({
    cloud: { url: "http://127.0.0.1:9", onSyncError: "warn" },
  });
  console.log("\ncloud down:");
  await down.register(tools); // warns instead of throwing; the tools stay registered locally
  try {
    await down.searchAsync(QUERY, 3);
  } catch (error) {
    if (!(error instanceof CloudError)) throw error;
    console.log(`  search          : CloudError code=${error.code}`);
  }
} finally {
  await local?.close();
}
