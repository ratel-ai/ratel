#!/usr/bin/env node
/**
 * End-to-end check for the installed `@ratel-ai/sdk` package.
 *
 * Assumes `@ratel-ai/sdk` (the tarball packed on this PR) + its matching platform
 * binary subpackage are already `npm install`ed in the current directory. Loads the
 * shared fixture catalog, drives the full product surface through the PUBLIC API, and
 * asserts behavior against e2e/scenario.json:
 *
 *   1. ToolCatalog.search       — dense ranking (top-1 per query)
 *   2. ToolCatalog.invoke       — executor dispatch
 *   3. searchToolsTool          — gateway search surface (grouped hits)
 *   4. invokeToolTool           — gateway invoke surface
 *   5. SkillCatalog.search      — dense ranking over the skill corpus (top-1 per query)
 *   6. getSkillContentTool      — load a skill body by id (+ unknown-id error path)
 *   7. searchCapabilitiesTool   — unified gateway over tools AND skills (two buckets)
 *   8. searchCapabilitiesTool   — skill->tool cross-pollination (declared tools, score 0)
 *
 * Exits non-zero on any mismatch. The same assertions run from the Python runner, so
 * a cross-SDK divergence makes exactly one side fail.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ToolCatalog,
  SkillCatalog,
  searchToolsTool,
  invokeToolTool,
  searchCapabilitiesTool,
  getSkillContentTool,
} from "@ratel-ai/sdk";

// RATEL_E2E_DIR lets CI copy this script next to the installed `@ratel-ai/sdk`
// (so the bare import resolves against the artifact, not the workspace source)
// while still loading the fixtures from the repo's e2e/ directory.
const E2E_DIR = process.env.RATEL_E2E_DIR || dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG = JSON.parse(readFileSync(join(E2E_DIR, "fixtures", "catalog.json"), "utf8"));
const SKILLS = JSON.parse(readFileSync(join(E2E_DIR, "fixtures", "skills.json"), "utf8"));
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

function buildSkillCatalog() {
  const catalog = new SkillCatalog();
  for (const skill of SKILLS.skills) {
    catalog.register({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags ?? [],
      tools: skill.tools ?? [],
      metadata: skill.metadata ?? {},
      body: skill.body ?? "",
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

  // --- Skills surface (0.2.0) ---------------------------------------------
  const skillCatalog = buildSkillCatalog();
  const nSkills = SKILLS.skills.length;
  const skillsById = new Map(SKILLS.skills.map((s) => [s.id, s]));

  // 5. Skill search ranking parity (separate dense corpus from tools).
  for (const { query, topK, expectTop1 } of SCENARIO.skillSearches) {
    const hits = skillCatalog.search(query, topK);
    if (!Array.isArray(hits) || hits.length === 0) fail(`skill search returned no hits for ${query}`);
    if (hits.length > topK) fail(`skill search returned ${hits.length} hits > topK=${topK} for ${query}`);
    if (hits[0].skillId !== expectTop1) {
      fail(`skill top-1 for ${query} was ${hits[0].skillId} (score ${hits[0].score}), expected ${expectTop1}`);
    }
    const scores = hits.map((h) => h.score);
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > scores[i - 1]) fail(`skill scores not descending for ${query}: ${scores}`);
    }
    console.log(`  skill search OK: ${query} -> ${hits[0].skillId} (${hits[0].score.toFixed(4)})`);
  }

  // 6. getSkillContent — body round-trip + unknown-id structured error.
  const getSkill = getSkillContentTool(skillCatalog);
  const sc = SCENARIO.skillContent;
  const scOut = await getSkill.execute({ skillId: sc.skillId });
  const wantBody = skillsById.get(sc.skillId).body;
  if (scOut.body !== wantBody) fail(`get_skill_content body for ${sc.skillId} was ${JSON.stringify(scOut.body)}, expected ${JSON.stringify(wantBody)}`);
  console.log(`  get_skill_content OK: ${sc.skillId} -> ${wantBody.length} bytes`);

  const unk = SCENARIO.skillContentUnknown;
  const unkOut = await getSkill.execute({ skillId: unk.skillId });
  if (!unkOut.isError) fail(`get_skill_content for unknown ${unk.skillId} should set isError; got ${JSON.stringify(unkOut)}`);
  if ("body" in unkOut) fail(`get_skill_content for unknown ${unk.skillId} should not return a body; got ${JSON.stringify(unkOut)}`);
  console.log(`  get_skill_content unknown-id OK: ${unk.skillId} -> isError`);

  // 7. searchCapabilities — unified gateway returns tools AND skills buckets.
  const cap = SCENARIO.capabilities;
  const searchCaps = searchCapabilitiesTool(catalog, skillCatalog);
  const capOut = await searchCaps.execute({ query: cap.query, topKTools: cap.topKTools, topKSkills: cap.topKSkills });
  const capToolIds = (capOut.tools?.groups ?? []).flatMap((g) => (g.hits ?? []).map((h) => h.toolId));
  const capSkillIds = (capOut.skills ?? []).map((s) => s.skillId);
  if (!capToolIds.includes(cap.expectToolId)) fail(`search_capabilities tools bucket missing ${cap.expectToolId}; got ${capToolIds}`);
  if (!capSkillIds.includes(cap.expectSkillId)) fail(`search_capabilities skills bucket missing ${cap.expectSkillId}; got ${capSkillIds}`);
  console.log(`  search_capabilities OK: ${cap.query} -> tools=${capToolIds} skills=${capSkillIds}`);

  // 8. searchCapabilities — skill->tool cross-pollination. A matched skill's
  //    declared tools ride into the tools bucket at score 0, even when the query
  //    doesn't rank them in its own top-K. The expected tool falls outside the
  //    query's dense top-K, so presence + score 0 proves it arrived via the
  //    skill, not a direct query match.
  const xp = SCENARIO.capabilitiesCrossPollination;
  const xpOut = await searchCaps.execute({ query: xp.query, topKTools: xp.topKTools, topKSkills: xp.topKSkills });
  const xpSkillIds = (xpOut.skills ?? []).map((s) => s.skillId);
  if (!xpSkillIds.includes(xp.expectSkillId)) fail(`cross-pollination: skills bucket missing ${xp.expectSkillId}; got ${xpSkillIds}`);
  const xpHits = new Map((xpOut.tools?.groups ?? []).flatMap((g) => (g.hits ?? []).map((h) => [h.toolId, h])));
  const wantTool = xp.expectCrossPollinatedToolId;
  if (!xpHits.has(wantTool)) fail(`cross-pollination: tools bucket missing skill-declared ${wantTool}; got ${[...xpHits.keys()]}`);
  if (xpHits.get(wantTool).score !== 0) {
    fail(`cross-pollination: ${wantTool} score was ${xpHits.get(wantTool).score}, expected 0 (non-zero means it matched the query directly, not via the skill)`);
  }
  console.log(`  cross-pollination OK: ${xp.expectSkillId} -> pulled in ${wantTool} (score 0)`);

  console.log(`PASS (ts): ${nTools} tools, ${SCENARIO.searches.length} search cases, ${nSkills} skills, ${SCENARIO.skillSearches.length} skill-search cases, gateway + cross-pollination OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
