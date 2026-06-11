#!/usr/bin/env node
/**
 * End-to-end check for the installed `@ratel-ai/sdk` package.
 *
 * Assumes `@ratel-ai/sdk` (the tarball packed on this PR) + its matching platform
 * binary subpackage are already `npm install`ed in the current directory. Loads the
 * shared fixture catalog, drives the full product surface through the PUBLIC API, and
 * asserts behavior against e2e/scenario.json:
 *
 *   1. ToolCatalog.search  — BM25 ranking (top-1 per query)
 *   2. ToolCatalog.invoke  — executor dispatch
 *   3. searchToolsTool     — gateway search surface (grouped hits)
 *   4. invokeToolTool      — gateway invoke surface
 *
 * Exits non-zero on any mismatch. The same assertions run from the Python runner, so
 * a cross-SDK divergence makes exactly one side fail.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolCatalog, searchToolsTool, invokeToolTool } from "@ratel-ai/sdk";

// RATEL_E2E_DIR lets CI copy this script next to the installed `@ratel-ai/sdk`
// (so the bare import resolves against the artifact, not the workspace source)
// while still loading the fixtures from the repo's e2e/ directory.
const E2E_DIR = process.env.RATEL_E2E_DIR || dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG = JSON.parse(readFileSync(join(E2E_DIR, "fixtures", "catalog.json"), "utf8"));
const SCENARIO = JSON.parse(readFileSync(join(E2E_DIR, "scenario.json"), "utf8"));

function fail(msg) {
  console.error(`FAIL (ts): ${msg}`);
  process.exit(1);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildCatalog() {
  const catalog = new ToolCatalog();
  for (const tool of CATALOG.tools) {
    catalog.register({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? {},
      outputSchema: tool.outputSchema ?? {},
      execute: async (args) => ({ tool: tool.id, echo: args }),
    });
  }
  return catalog;
}

async function main() {
  const catalog = buildCatalog();
  const nTools = CATALOG.tools.length;

  // 1. Search ranking parity.
  for (const { query, topK, expectTop1 } of SCENARIO.searches) {
    const hits = catalog.search(query, topK);
    if (!Array.isArray(hits) || hits.length === 0) fail(`search returned no hits for ${query}`);
    if (hits.length > topK) fail(`search returned ${hits.length} hits > topK=${topK} for ${query}`);
    if (hits[0].toolId !== expectTop1) {
      fail(`top-1 for ${query} was ${hits[0].toolId} (score ${hits[0].score}), expected ${expectTop1}`);
    }
    const scores = hits.map((h) => h.score);
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > scores[i - 1]) fail(`scores not descending for ${query}: ${scores}`);
    }
    console.log(`  search OK: ${query} -> ${hits[0].toolId} (${hits[0].score.toFixed(4)})`);
  }

  // 2. Direct invoke.
  const inv = SCENARIO.invoke;
  const result = await catalog.invoke(inv.toolId, inv.args);
  const expected = { tool: inv.toolId, echo: inv.args };
  if (!deepEqual(result, expected)) fail(`invoke returned ${JSON.stringify(result)}, expected ${JSON.stringify(expected)}`);
  console.log(`  invoke OK: ${inv.toolId} -> ${JSON.stringify(result)}`);

  // 3. Gateway search surface.
  const gs = SCENARIO.gatewaySearch;
  const searchTool = searchToolsTool(catalog);
  const gsOut = await searchTool.execute({ query: gs.query, topK: gs.topK });
  const toolIds = (gsOut.groups ?? []).flatMap((g) => (g.hits ?? []).map((h) => h.toolId));
  if (!toolIds.includes(gs.expectToolId)) fail(`gateway search missing ${gs.expectToolId}; got ${toolIds}`);
  console.log(`  gateway search OK: ${gs.query} -> ${toolIds}`);

  // 4. Gateway invoke surface.
  const gi = SCENARIO.gatewayInvoke;
  const invokeTool = invokeToolTool(catalog);
  const giOut = await invokeTool.execute({ toolId: gi.toolId, args: gi.args });
  const giExpected = { tool: gi.toolId, echo: gi.args };
  if (!deepEqual(giOut, giExpected)) fail(`gateway invoke returned ${JSON.stringify(giOut)}, expected ${JSON.stringify(giExpected)}`);
  console.log(`  gateway invoke OK: ${gi.toolId} -> ${JSON.stringify(giOut)}`);

  console.log(`PASS (ts): ${nTools} tools, ${SCENARIO.searches.length} search cases, gateway OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
