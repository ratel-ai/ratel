#!/usr/bin/env node
/**
 * End-to-end check for the installed `@ratel-ai/cloud` package (+ `@ratel-ai/sdk`).
 *
 * Boots an in-process mock of Ratel Cloud's project-key API (catalog with
 * ETag/If-None-Match, trace-events ingestion, suggestions REST), then drives the
 * full SDK↔Cloud loop through the PUBLIC API:
 *
 *   1. syncSkills            — pull the published catalog into a live SkillCatalog
 *   2. search_capabilities   — a gateway tool built BEFORE sync advertises + serves
 *                              the synced skills afterwards (dynamic description)
 *   3. get_skill_content     — serves a synced skill body
 *   4. refresh()             — add/update/remove diffs land through the gateway
 *   5. CloudExporter         — drained envelopes reach the mock with Bearer auth,
 *                              monotonic seq, search_id linkage (gateway_search →
 *                              gateway_invoke), client_event_id format, and the
 *                              synced catalog_version stamped
 *   6. suggestions           — approve round-trip; the resulting skill arrives on
 *                              the next refresh()
 *
 * Exits non-zero on any mismatch. See e2e/README.md for how CI installs the
 * tarballs and copies this runner next to them (RATEL_E2E_DIR → fixtures).
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SkillCatalog, ToolCatalog, TraceSession, searchCapabilitiesTool, invokeToolTool, getSkillContentTool } from "@ratel-ai/sdk";
import { CloudClient } from "@ratel-ai/cloud";

const E2E_DIR = process.env.RATEL_E2E_DIR || dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS = JSON.parse(readFileSync(join(E2E_DIR, "fixtures", "skills.json"), "utf8"));

const API_KEY = "rtl_e2e_key";

function fail(msg) {
  console.error(`FAIL (cloud): ${msg}`);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

/** Fixture skill → CatalogSkillWire (all fields present on the wire). */
function toWire(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags ?? [],
    tools: skill.tools ?? [],
    metadata: skill.metadata ?? {},
    body: skill.body ?? "",
  };
}

// ---------------------------------------------------------------------------
// Inline mock Cloud (catalog + trace-events + suggestions project-key API).
// ---------------------------------------------------------------------------
const state = {
  version: "v1",
  skills: SKILLS.skills.map(toWire),
  suggestions: [
    {
      id: "sug-1",
      projectId: "proj-e2e",
      type: "new_skill",
      signalKind: "coverage_gap",
      status: "pending",
      rationale: "recurring ask with no matching skill",
      evidence: { queries: ["rotate the api keys"] },
      targetSkillId: null,
      targetSkillExpectedVersion: null,
      sourceQueryIntentId: null,
      patch: {
        name: "rotate-api-keys",
        description: "Playbook for rotating service API keys without downtime.",
        tags: ["security"],
        body: "# Rotate API keys\n1. Issue new key.\n2. Roll consumers.\n3. Revoke old key.\n",
      },
      retrievabilityPreview: null,
      createdSkillId: null,
      model: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      reviewedAt: null,
      appliedAt: null,
    },
  ],
  traceEvents: [],
  traceAuthHeaders: [],
};

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    const path = (req.url ?? "").split("?")[0];
    const json = (status, payload, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };

    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${API_KEY}`) return json(401, { error: "unauthorized" });

    if (req.method === "GET" && path === "/api/v1/catalog") {
      const etag = `"${state.version}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      return json(200, { catalogVersion: state.version, skills: state.skills }, { etag });
    }
    if (req.method === "POST" && path === "/api/v1/trace-events") {
      const events = Array.isArray(body) ? body : [body];
      state.traceEvents.push(...events);
      state.traceAuthHeaders.push(auth);
      return json(202, { accepted: events.length, rejected: [] });
    }
    if (req.method === "POST" && path === "/api/v1/suggestions/sug-1/approve") {
      const suggestion = state.suggestions[0];
      if (suggestion.status !== "pending") return json(409, { error: "conflict" });
      suggestion.status = "approved";
      // Approval publishes the drafted skill: it appears in the catalog.
      state.skills = [...state.skills, toWire(suggestion.patch)].map((s) => ({
        ...s,
        id: s.id ?? suggestion.patch.name,
      }));
      state.version = "v2-approved";
      return json(200, { suggestion });
    }
    if (req.method === "GET" && path === "/api/v1/suggestions") {
      return json(200, { count: state.suggestions.length, suggestions: state.suggestions });
    }
    return json(404, { error: "not_found" });
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// 1-3. Session + catalogs + gateway tools built BEFORE any cloud skill exists.
// ---------------------------------------------------------------------------
const session = new TraceSession({ sessionId: "e2e-session", harness: "e2e" });
const toolCatalog = new ToolCatalog({ traceSession: session });
toolCatalog.register({
  id: "github__merge_pull_request",
  name: "merge_pull_request",
  description: "Merge an approved pull request into the default branch.",
  inputSchema: {},
  outputSchema: {},
  execute: async () => ({ merged: true }),
});
const skillCatalog = new SkillCatalog({ traceSession: session });
const searchTool = searchCapabilitiesTool(toolCatalog, skillCatalog);
const invokeTool = invokeToolTool(toolCatalog);
const skillContentTool = getSkillContentTool(skillCatalog);

assert(
  !searchTool.description.includes("get_skill_content"),
  "pre-sync description must not advertise skills",
);

const cloud = new CloudClient({ baseUrl, apiKey: API_KEY });
const sync = await cloud.syncSkills(skillCatalog, { traceSession: session });

assert(skillCatalog.size() === SKILLS.skills.length, "all fixture skills synced");
assert(
  searchTool.description.includes("get_skill_content"),
  "post-sync description advertises skills (dynamic getter)",
);

const searchResult = await searchTool.execute({ query: "deploy the web service to production" });
assert(
  searchResult.skills.some((s) => s.skillId === "deploy-web-service"),
  "synced skill surfaces through search_capabilities",
);
const content = await skillContentTool.execute({ skillId: "deploy-web-service" });
assert(content.body.includes("Tag the release"), "get_skill_content serves the synced body");

// ---------------------------------------------------------------------------
// 4. Mutations: update one skill, drop another, refresh, observe via gateway.
// ---------------------------------------------------------------------------
state.skills = state.skills
  .filter((s) => s.id !== "onboard-new-engineer")
  .map((s) =>
    s.id === "speed-up-slow-query"
      ? { ...s, description: "Playbook for tuning a slow MySQL query with the right index." }
      : s,
  );
state.version = "v2";

const diff = await sync.refresh();
assert(diff.changed, "refresh reports a change");
assert(diff.removed.includes("onboard-new-engineer"), "removed skill reported");
assert(diff.updated.includes("speed-up-slow-query"), "updated skill reported");
const gone = await skillContentTool.execute({ skillId: "onboard-new-engineer" });
assert(gone.isError === true, "removed skill no longer served");
assert(
  skillCatalog.get("speed-up-slow-query")?.description.includes("MySQL"),
  "updated skill content applied",
);

// ---------------------------------------------------------------------------
// 5. Exporter: gateway search → invoke, flush, assert the wire.
// ---------------------------------------------------------------------------
await searchTool.execute({ query: "merge the approved pull request" });
await invokeTool.execute({ toolId: "github__merge_pull_request", args: {} });

const exporter = cloud.createExporter(session);
await exporter.flush();

assert(state.traceEvents.length > 0, "exporter delivered events");
assert(
  state.traceAuthHeaders.every((h) => h === `Bearer ${API_KEY}`),
  "exporter authenticates with the project key",
);
const seqs = state.traceEvents.map((e) => e.seq);
assert(
  seqs.every((s, i) => i === 0 || s > seqs[i - 1]),
  "seq is strictly increasing across the whole session",
);
assert(
  state.traceEvents.every((e) => e.client_event_id === `e2e-session:${e.seq}`),
  "client_event_id is session_id:seq",
);
const gwSearch = state.traceEvents.findLast((e) => e.type === "gateway_search");
const gwInvoke = state.traceEvents.find((e) => e.type === "gateway_invoke");
assert(typeof gwSearch?.search_id === "string", "gateway_search carries a search_id");
assert(gwInvoke?.search_id === gwSearch.search_id, "gateway_invoke links to its gateway_search");
assert(
  Array.isArray(gwSearch.tool_hits) && gwSearch.tool_hits[0].rank === 0,
  "gateway_search carries ranked tool_hits",
);
const postSync = state.traceEvents.find((e) => e.catalog_version === "v2");
assert(postSync !== undefined, "catalog_version stamped on envelopes after sync");

// ---------------------------------------------------------------------------
// 6. Suggestions: approve → published → arrives on the next refresh.
// ---------------------------------------------------------------------------
const pending = await cloud.suggestions.list();
assert(pending.count === 1 && pending.suggestions[0].status === "pending", "pending suggestion listed");
const approved = await cloud.suggestions.approve("sug-1");
assert(approved.status === "approved", "suggestion approved");
const afterApprove = await sync.refresh();
assert(afterApprove.added.includes("rotate-api-keys"), "approved skill arrives via refresh");
const rotated = await skillContentTool.execute({ skillId: "rotate-api-keys" });
assert(rotated.body.includes("Issue new key"), "approved skill body served");

await exporter.shutdown();
sync.stop();
server.close();

console.log("PASS (cloud): sync + hot-reload + exporter linkage + suggestion approve round-trip");
