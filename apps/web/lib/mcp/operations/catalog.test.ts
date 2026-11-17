import assert from "node:assert/strict";
import { test } from "node:test";
import type { Skill } from "@/lib/catalog/schema";
import type { SkillsCatalogData, ToolsCatalogData } from "@/lib/console/catalog/load";
import {
  observedTool,
  runtimeDefinition,
  skillRecord,
  syncedTool,
} from "@/lib/console/catalog/test-support";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import { buildToolsCatalog } from "@/lib/synthesis/catalog/tools";
import { type CatalogOperationDeps, catalogOperations } from "./catalog";

/**
 * `list_runtime_catalog` exists because `set_catalog_override` writes by
 * entryId and nothing else on the surface lists one: these pin that the id is
 * the runtime's (not the tool name), that the searchable description says
 * where it comes from, and that the page's filters and sorts carry over.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function toolsData(patch: Partial<ToolsCatalogData> = {}): ToolsCatalogData {
  const definitions = [
    // The runtime names an MCP server's tool `<server>__<tool>` in its id: the id is not the name.
    runtimeDefinition("http_post", {
      entryId: "web__http_post",
      description: "POST a JSON body.",
      searchableDescription: "POST a JSON body.",
      searchableDescriptionOverride: "Send a JSON payload to any URL over HTTP POST.",
      tags: ["network"],
    }),
    runtimeDefinition("fetch_url", {
      description: "Fetch.",
      searchableDescription: "Fetch a web page by URL.",
    }),
    runtimeDefinition("search_docs"),
  ];
  return {
    tools: buildToolsCatalog(
      [
        observedTool("http_post", 12),
        observedTool("legacy_export", 3),
        observedTool("search_docs", 1),
      ],
      [syncedTool("fetch_url", "source-a", { sourceStatus: "stale" })],
      definitions,
    ),
    runtimeEntries: definitions,
    editable: true,
    adopted: null,
    syncGuide: true,
    ...patch,
  };
}

function skillsData(patch: Partial<SkillsCatalogData> = {}): SkillsCatalogData {
  return {
    skills: [
      skillRecord("refund-policy", { searchableDescription: "Refunds, returns and chargebacks." }),
    ],
    runtimeSkills: [
      runtimeDefinition("triage", {
        entryId: "skill-triage",
        searchableDescriptionOverride: "Sort incoming tickets by urgency.",
      }),
      {
        entryId: null,
        name: "ghost-skill",
        provenance: "observed",
        lastSeenAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    ],
    runs: { "refund-policy": { runs: 4, lastRunAt: "2026-10-10T00:00:00.000Z" } },
    searchableEnabled: true,
    runtimeEditable: true,
    adopted: false,
    bodiesIncluded: false,
    ...patch,
  };
}

function unused(name: string) {
  return async () => {
    throw new Error(`${name} should not be called`);
  };
}

function deps(overrides: Partial<CatalogOperationDeps> = {}): CatalogOperationDeps {
  return {
    listSkills: unused("listSkills"),
    getSkillById: unused("getSkillById"),
    getCatalogCounts: unused("getCatalogCounts"),
    getSkillCatalogAdoption: unused("getSkillCatalogAdoption"),
    getProjectCatalogVersion: unused("getProjectCatalogVersion"),
    listSyncedTools: unused("listSyncedTools"),
    listObservedTools: unused("listObservedTools"),
    listToolDefinitions: unused("listToolDefinitions"),
    listRuntimeCatalogOverrides: unused("listRuntimeCatalogOverrides"),
    listSkillRunCounts: unused("listSkillRunCounts"),
    loadToolsCatalog: async () => toolsData(),
    loadSkillsCatalog: async () => skillsData(),
    ...overrides,
  } as CatalogOperationDeps;
}

interface Entry {
  kind: string;
  name: string;
  source: string;
  entryId: string | null;
  skillId: string | null;
  agentDescription: string | null;
  searchable: {
    inEffect: string;
    origin: string;
    runtimeDefault: string | null;
    override: string | null;
    overrideAdoption: string | null;
    editWith: string;
  } | null;
  tags: string[];
  stale: boolean;
  usage: Record<string, unknown>;
}

interface CatalogPage {
  count: number;
  total: number;
  totals: { tools: number; skills: number };
  entries: Entry[];
}

async function list(
  params: Record<string, unknown>,
  overrides: Partial<CatalogOperationDeps> = {},
) {
  const result = await dispatchOperation("list_runtime_catalog", params, {
    registry: buildRegistry(catalogOperations(deps(overrides))),
    auth,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as { ok: true; data: CatalogPage; truncated?: boolean };
}

function byName(page: CatalogPage, name: string): Entry {
  const entry = page.entries.find((candidate) => candidate.name === name);
  assert.ok(entry, `${name} should be listed`);
  return entry;
}

test("a managed tool carries the runtime's entryId, not its name, and points at set_catalog_override", async () => {
  const { data } = await list({ kind: "tool" });
  const tool = byName(data, "http_post");

  assert.equal(tool.entryId, "web__http_post");
  assert.equal(tool.source, "managed");
  assert.deepEqual(tool.tags, ["network"]);
  assert.equal(tool.searchable?.editWith, "set_catalog_override");
  assert.equal(tool.searchable?.inEffect, "Send a JSON payload to any URL over HTTP POST.");
  assert.equal(tool.searchable?.origin, "cloud");
  assert.equal(tool.searchable?.runtimeDefault, "POST a JSON body.");
  assert.equal(tool.searchable?.override, "Send a JSON payload to any URL over HTTP POST.");
  // No recent override pull and no runtime flag: adoption is unproven, not refused.
  assert.equal(tool.searchable?.overrideAdoption, "unconfirmed");
  assert.equal(tool.usage.calls, 12);
});

test("where the searchable text comes from: the runtime's own text, or the agent description", async () => {
  const { data } = await list({ kind: "tool" });

  assert.equal(byName(data, "fetch_url").searchable?.origin, "runtime");
  assert.equal(byName(data, "fetch_url").searchable?.overrideAdoption, null);
  assert.equal(byName(data, "search_docs").searchable?.origin, "agent");
});

test("a recent override pull reads as adopted", async () => {
  const { data } = await list(
    { kind: "tool" },
    { loadToolsCatalog: async () => toolsData({ adopted: true }) },
  );
  assert.equal(byName(data, "http_post").searchable?.overrideAdoption, "adopted");
});

test("a tool seen only in traces has no entryId and nothing to override", async () => {
  const { data } = await list({ kind: "tool", source: "observed" });

  assert.deepEqual(
    data.entries.map((entry) => entry.name),
    ["legacy_export"],
  );
  assert.equal(data.entries[0]?.entryId, null);
  assert.equal(data.entries[0]?.searchable, null);
});

test("a tool whose every source went quiet is flagged stale", async () => {
  const { data } = await list({ kind: "tool" });
  assert.equal(byName(data, "fetch_url").stale, true);
  assert.equal(byName(data, "http_post").stale, false);
});

test("skills: a Ratel skill is edited with update_skill, a runtime one by entryId", async () => {
  const { data } = await list({ kind: "skill" }, { loadToolsCatalog: unused("loadToolsCatalog") });

  const cloud = byName(data, "refund-policy");
  assert.equal(cloud.source, "cloud");
  assert.equal(cloud.skillId, "id-refund-policy");
  assert.equal(cloud.entryId, null);
  assert.equal(cloud.searchable?.editWith, "update_skill");
  assert.equal(cloud.searchable?.origin, "cloud");
  assert.equal(cloud.usage.runs, 4);

  const runtime = byName(data, "triage");
  assert.equal(runtime.entryId, "skill-triage");
  assert.equal(runtime.searchable?.editWith, "set_catalog_override");
  // The catalog version evidence says the runtime serves an older catalog.
  assert.equal(runtime.searchable?.overrideAdoption, "not_adopted");

  assert.equal(byName(data, "ghost-skill").entryId, null);
  assert.equal(data.totals.tools, 0);
});

test("kind tool never loads the skills catalog", async () => {
  const { data } = await list({ kind: "tool" }, { loadSkillsCatalog: unused("loadSkillsCatalog") });
  assert.equal(data.totals.skills, 0);
  assert.ok(data.entries.every((entry) => entry.kind === "tool"));
});

test("query matches the searchable text in effect, not only the name", async () => {
  const { data } = await list({ query: "any url" });
  assert.deepEqual(
    data.entries.map((entry) => entry.name),
    ["http_post"],
  );
});

test("tools come before skills, each sorted by the page's comparator, and pages report the rest", async () => {
  const sorted = await list({ sort: "name" });
  assert.deepEqual(
    sorted.data.entries.map((entry) => entry.name),
    [
      "fetch_url",
      "http_post",
      "legacy_export",
      "search_docs",
      "ghost-skill",
      "refund-policy",
      "triage",
    ],
  );

  const page = await list({ sort: "calls", limit: 2, offset: 0 });
  assert.deepEqual(
    page.data.entries.map((entry) => entry.name),
    ["http_post", "legacy_export"],
  );
  assert.equal(page.data.total, 7);
  assert.equal(page.truncated, true);

  const last = await list({ sort: "name", limit: 2, offset: 6 });
  assert.deepEqual(
    last.data.entries.map((entry) => entry.name),
    ["triage"],
  );
  assert.equal(last.truncated, undefined);
});

test("long descriptions are cut and the result says so", async () => {
  const long = "word ".repeat(200);
  const definitions = [
    runtimeDefinition("verbose", { description: long, searchableDescription: long }),
  ];
  const { data, truncated } = await list(
    { kind: "tool" },
    {
      loadToolsCatalog: async () =>
        toolsData({ tools: buildToolsCatalog([], [], definitions), runtimeEntries: definitions }),
    },
  );
  const entry = byName(data, "verbose");
  assert.ok((entry.agentDescription?.length ?? 0) < long.length);
  assert.equal(truncated, true);
});

/* ------------------------------- list_skills ------------------------------- */

function skillRow(name: string, patch: Partial<Skill> = {}): Skill {
  return {
    id: `id-${name}`,
    projectId: PROJECT,
    name,
    description: `Use ${name}.`,
    searchableDescription: null,
    body: `# ${name}`,
    tags: [],
    tools: [],
    metadata: {},
    status: "published",
    version: 1,
    endUserId: null,
    model: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    publishedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...patch,
  } as Skill;
}

const SKILLS = [
  skillRow("alpha", { updatedAt: new Date("2026-10-03T00:00:00.000Z") }),
  skillRow("bravo", {
    description: "Handles refunds.",
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
  }),
  skillRow("charlie", {
    searchableDescription: "refund disputes",
    updatedAt: new Date("2026-10-02T00:00:00.000Z"),
  }),
];

async function listSkills(
  params: Record<string, unknown>,
  overrides: Partial<CatalogOperationDeps> = {},
) {
  const result = await dispatchOperation("list_skills", params, {
    registry: buildRegistry(catalogOperations(deps(overrides))),
    auth,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as {
    ok: true;
    data: { count: number; total?: number; skills: Array<{ name: string; runs?: number }> };
    truncated?: boolean;
  };
}

test("list_skills without search or sort pages in the database, as before", async () => {
  const calls: unknown[] = [];
  const { data } = await listSkills(
    { limit: 2, offset: 4 },
    {
      listSkills: async (_projectId, options) => {
        calls.push(options);
        return SKILLS;
      },
    },
  );
  assert.deepEqual(calls, [{ status: undefined, endUser: undefined, limit: 3, offset: 4 }]);
  assert.equal(data.count, 2);
});

test("list_skills query matches the name, description or searchable description", async () => {
  const { data } = await listSkills({ query: "REFUND" }, { listSkills: async () => SKILLS });
  // Newest first by default: charlie (Oct 2) before bravo (Oct 1).
  assert.deepEqual(
    data.skills.map((skill) => skill.name),
    ["charlie", "bravo"],
  );
  assert.equal(data.total, 2);
});

test("list_skills sorts by name and by runs, reading run counts only for runs", async () => {
  const byName = await listSkills(
    { sort: "name", direction: "desc" },
    { listSkills: async () => SKILLS },
  );
  assert.deepEqual(
    byName.data.skills.map((skill) => skill.name),
    ["charlie", "bravo", "alpha"],
  );

  const byRuns = await listSkills(
    { sort: "runs" },
    {
      listSkills: async () => SKILLS,
      listSkillRunCounts: async () => [
        { skillId: "bravo", runs: 9, lastRunAt: new Date("2026-10-04T00:00:00.000Z") },
        { skillId: "alpha", runs: 2, lastRunAt: new Date("2026-10-04T00:00:00.000Z") },
      ],
    },
  );
  assert.deepEqual(
    byRuns.data.skills.map((skill) => [skill.name, skill.runs]),
    [
      ["bravo", 9],
      ["alpha", 2],
      ["charlie", 0],
    ],
  );
});
