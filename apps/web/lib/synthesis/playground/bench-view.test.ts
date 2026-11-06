import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BenchEntry,
  buildSkillEntries,
  buildToolEntries,
  compareEntries,
  filterCounts,
  groupEntries,
  isUndescribed,
  matchesSearch,
  parseTags,
  ranksById,
  resolveOverrideSave,
  saveAffordance,
  visibleEntries,
} from "./bench-view";
import { BENCH_ENTRY_DEFAULTS, BENCH_SKILL_DEFAULTS, BENCH_TOOL_DEFAULTS } from "./test-support";
import type { BenchSkill, BenchTool, DraftsByKind } from "./types";

const NO_DRAFTS: DraftsByKind = { skill: {}, tool: {} };

const row = (over: Partial<BenchEntry> & { id: string }): BenchEntry => ({
  ...BENCH_ENTRY_DEFAULTS,
  kind: "tool",
  description: "A description.",
  edited: false,
  rank: null,
  calls: 0,
  hasDefinition: true,
  status: null,
  ...over,
});

const skill = (name: string, over: Partial<BenchSkill> = {}): BenchSkill => ({
  ...BENCH_SKILL_DEFAULTS,
  id: `id-${name}`,
  name,
  description: `Description for ${name}.`,
  tags: [],
  tools: [],
  status: "published",
  version: 1,
  ...over,
});

const tool = (name: string, over: Partial<BenchTool> = {}): BenchTool => ({
  ...BENCH_TOOL_DEFAULTS,
  name,
  description: `Description for ${name}.`,
  hasDefinition: true,
  calls: 0,
  ...over,
});

const entry = (over: Partial<BenchEntry> & { id: string }): BenchEntry => ({
  ...BENCH_ENTRY_DEFAULTS,
  kind: "tool",
  description: "d",
  edited: false,
  rank: null,
  calls: null,
  hasDefinition: true,
  status: null,
  ...over,
});

test("buildSkillEntries reports the drafted description and the edit flag", () => {
  const [plain, edited] = buildSkillEntries(
    [skill("alpha"), skill("beta")],
    { skill: { beta: { description: "Rewritten." } }, tool: {} },
    ranksById([{ id: "alpha", rank: 2 }]),
  );
  assert.equal(plain.description, "Description for alpha.");
  assert.equal(plain.edited, false);
  assert.equal(plain.rank, 2);
  assert.equal(plain.status, "published");
  assert.equal(edited.description, "Rewritten.");
  assert.equal(edited.edited, true);
  assert.equal(edited.rank, null);
});

test("buildToolEntries carries calls and the missing-definition flag", () => {
  const [entryOne] = buildToolEntries(
    [tool("ripgrep", { calls: 12, hasDefinition: false, description: "" })],
    NO_DRAFTS,
    new Map(),
  );
  assert.equal(entryOne.calls, 12);
  assert.equal(entryOne.hasDefinition, false);
  assert.equal(entryOne.status, null);
  assert.equal(isUndescribed(entryOne), true);
});

test("a whitespace-only description counts as undescribed", () => {
  assert.equal(isUndescribed(entry({ id: "a", description: "   " })), true);
  assert.equal(isUndescribed(entry({ id: "a", description: "x" })), false);
});

test("search matches the id and the description, case-insensitively", () => {
  const row = entry({ id: "github_api", description: "Read pull requests." });
  assert.equal(matchesSearch(row, ""), true);
  assert.equal(matchesSearch(row, "  "), true);
  assert.equal(matchesSearch(row, "GITHUB"), true);
  assert.equal(matchesSearch(row, "pull"), true);
  assert.equal(matchesSearch(row, "ripgrep"), false);
});

test("ranked rows sort first, in rank order, ahead of edited and busy ones", () => {
  // After a run, the rows worth reading are the ones that placed. Scanning 200
  // alphabetical tools to find the three that moved is the failure this order
  // exists to prevent.
  const rows = [
    entry({ id: "zeta-busy", calls: 900 }),
    entry({ id: "alpha-edited", edited: true }),
    entry({ id: "ranked-2", rank: 2 }),
    entry({ id: "ranked-1", rank: 1 }),
  ];
  assert.deepEqual(
    [...rows].sort(compareEntries).map((row) => row.id),
    ["ranked-1", "ranked-2", "alpha-edited", "zeta-busy"],
  );
});

test("unranked rows fall back to edited, then call volume, then name", () => {
  const rows = [
    entry({ id: "b-quiet", calls: 1 }),
    entry({ id: "a-quiet", calls: 1 }),
    entry({ id: "loud", calls: 500 }),
    entry({ id: "changed", edited: true }),
  ];
  assert.deepEqual(
    [...rows].sort(compareEntries).map((row) => row.id),
    ["changed", "loud", "a-quiet", "b-quiet"],
  );
});

test("filters narrow to the rows they name", () => {
  const rows = [
    entry({ id: "ranked", rank: 1 }),
    entry({ id: "edited", edited: true }),
    entry({ id: "blank", description: "" }),
    entry({ id: "plain" }),
  ];
  const ids = (filter: Parameters<typeof visibleEntries>[1]["filter"]) =>
    visibleEntries(rows, { search: "", filter }).map((row) => row.id);

  assert.equal(ids("all").length, 4);
  assert.deepEqual(ids("ranked"), ["ranked"]);
  assert.deepEqual(ids("edited"), ["edited"]);
  assert.deepEqual(ids("blank" as never), []);
  assert.deepEqual(ids("undescribed"), ["blank"]);
});

test("search and filter compose", () => {
  const rows = [
    entry({ id: "github_api", edited: true }),
    entry({ id: "gitlab_api", edited: true }),
    entry({ id: "ripgrep" }),
  ];
  assert.deepEqual(
    visibleEntries(rows, { search: "github", filter: "edited" }).map((row) => row.id),
    ["github_api"],
  );
});

test("filterCounts drives the chip counts, including zero", () => {
  const counts = filterCounts([
    entry({ id: "a", rank: 1 }),
    entry({ id: "b", edited: true }),
    entry({ id: "c" }),
  ]);
  assert.deepEqual(counts, { all: 3, ranked: 1, edited: 1, undescribed: 0 });
  assert.deepEqual(filterCounts([]), {
    all: 0,
    ranked: 0,
    edited: 0,
    undescribed: 0,
  });
});

test("parseTags splits on commas and newlines, dropping blanks and repeats", () => {
  assert.deepEqual(parseTags("git, review"), ["git", "review"]);
  assert.deepEqual(parseTags(" git ,, review \n git "), ["git", "review"]);
  assert.deepEqual(parseTags(""), []);
  assert.deepEqual(parseTags(" , , "), []);
});

test("groupEntries gives the list an entry point without hiding anything", () => {
  const entries = [
    row({ id: "ranked-1", rank: 1 }),
    row({ id: "ranked-2", rank: 2 }),
    row({ id: "edited-only", edited: true }),
    row({ id: "plain-a" }),
    row({ id: "plain-b" }),
  ];
  const groups = groupEntries(entries);

  assert.deepEqual(
    groups.map((group) => [group.key, group.label, group.entries.length]),
    [
      ["results", "In results", 2],
      ["edited", "Edited", 1],
      ["rest", "Everything else", 2],
    ],
  );
  // Nothing is filtered out: the capability that did NOT rank is exactly what
  // someone debugging retrieval came to look at.
  assert.equal(
    groups.reduce((sum, group) => sum + group.entries.length, 0),
    entries.length,
  );
});

test("groupEntries leaves a single band unlabelled", () => {
  // A header over the whole list names nothing.
  const groups = groupEntries([row({ id: "a" }), row({ id: "b" })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "");
});

test("an edited row that also ranked belongs to the results band", () => {
  const groups = groupEntries([row({ id: "a", rank: 1, edited: true })]);
  assert.deepEqual(
    groups.map((group) => group.key),
    ["results"],
  );
});

/* — The two descriptions on a bench row ————————————————————————————————————— */

test("a bench row shows the match text, and the agent's only when it differs", () => {
  const [managed] = buildToolEntries(
    [
      tool("calendar_create", {
        entryId: "calendar.create",
        description: "Persists an ICS entity to the organizer backend.",
        searchableDescription: "schedule a meeting",
      }),
    ],
    NO_DRAFTS,
    new Map(),
  );
  assert.equal(managed.description, "schedule a meeting", "what is matched");
  assert.equal(
    managed.agentDescription,
    "Persists an ICS entity to the organizer backend.",
    "what the agent receives",
  );
  assert.equal(managed.searchableDescriptionSource, "runtime");
  assert.equal(managed.entryId, "calendar.create");
});

test("identical texts collapse to one, so no surface prints the same paragraph twice", () => {
  // Ingest copies description into searchable_description, so this is the
  // ordinary shape rather than an edge case.
  const [entry] = buildToolEntries(
    [
      tool("ripgrep", {
        entryId: "ripgrep",
        description: "Search the repository.",
        searchableDescription: "Search the repository.",
      }),
    ],
    NO_DRAFTS,
    new Map(),
  );
  assert.equal(entry.description, "Search the repository.");
  assert.equal(entry.agentDescription, null, "there is one text, not two");
  assert.equal(entry.searchableDescriptionSource, "runtime");
});

test("a drafted row reports the drafted match text and the unchanged agent text", () => {
  const [entry] = buildToolEntries(
    [
      tool("calendar_create", {
        entryId: "calendar.create",
        description: "Persists an ICS entity.",
        searchableDescription: "schedule a meeting",
      }),
    ],
    { skill: {}, tool: { calendar_create: { description: "reserve a room" } } },
    new Map(),
  );
  assert.equal(entry.description, "reserve a room");
  assert.equal(entry.agentDescription, "Persists an ICS entity.");
  assert.equal(entry.searchableDescriptionSource, "override");
  assert.equal(entry.edited, true);
});

test("a skill row carries no tool-only usage or runtime key", () => {
  const [entry] = buildSkillEntries([skill("triage")], NO_DRAFTS, new Map());
  assert.equal(entry.entryId, null);
  assert.equal(entry.tokens, null);
  assert.equal(entry.costProvenance, null);
});

test("a tool row carries usage with its provenance, never as a bare number", () => {
  const [entry] = buildToolEntries(
    [
      tool("ripgrep", {
        tokens: 1200,
        tokensProvenance: "otel",
        costUsd: 0.4,
        costProvenance: "otel",
      }),
    ],
    NO_DRAFTS,
    new Map(),
  );
  assert.equal(entry.tokens, 1200);
  assert.equal(entry.tokensProvenance, "otel");
  assert.equal(entry.costUsd, 0.4);
  assert.equal(entry.costProvenance, "otel");
});

/* — What Save may do ————————————————————————————————————————————————————————— */

test("a skill always saves through the catalog route", () => {
  assert.deepEqual(
    saveAffordance(entry({ id: "triage", kind: "skill" }), {
      canSaveSearchableDescription: true,
    }),
    { kind: "skill", label: "Save to catalog" },
  );
});

test("a runtime-managed tool saves its searchable description", () => {
  const affordance = saveAffordance(entry({ id: "calendar_create", entryId: "calendar.create" }), {
    canSaveSearchableDescription: true,
  });
  assert.equal(affordance.kind, "searchable-description");
});

test("a tool the runtime never ingested is refused, with the reason", () => {
  // Not by hiding the control: the endpoint 404s a missing entry regardless.
  // This is only about saying why, instead of offering a dead button.
  const affordance = saveAffordance(entry({ id: "ripgrep", entryId: null }), {
    canSaveSearchableDescription: true,
  });
  assert.equal(affordance.kind, "blocked");
  assert.match(
    affordance.kind === "blocked" ? affordance.reason : "",
    /Register this tool through the Ratel runtime/,
  );
});

test("a managed tool is refused while the write surface is closed", () => {
  const affordance = saveAffordance(entry({ id: "calendar_create", entryId: "calendar.create" }), {
    canSaveSearchableDescription: false,
  });
  assert.equal(affordance.kind, "blocked");
  assert.match(
    affordance.kind === "blocked" ? affordance.reason : "",
    /runtime catalog API is off/,
  );
});

/* — What Save writes ————————————————————————————————————————————————————————— */

/**
 * "What if I delete it all? Will it just go back to the default one?"
 *
 * Yes — and that has to be a rule, not a coincidence of whatever the endpoint
 * does with an empty string. An empty override would leave the capability
 * matching on nothing at all, which is the opposite of what emptying a field
 * means to the person doing it.
 */
test("clearing the field removes the override rather than storing an empty one", () => {
  assert.equal(resolveOverrideSave("", "runtime text"), null);
  assert.equal(resolveOverrideSave("   \n  ", "runtime text"), null);
});

test("typing the runtime's own words back also means stop overriding", () => {
  // Storing it would create a duplicate that silently stops tracking the
  // runtime: re-ingest would move the default and the copy would not follow.
  assert.equal(resolveOverrideSave("runtime text", "runtime text"), null);
});

test("anything else is stored verbatim", () => {
  assert.equal(resolveOverrideSave("reserve a room", "runtime text"), "reserve a room");
  // Not trimmed here: trimming is the save boundary's job, and this rule is
  // only deciding override-versus-clear.
  assert.equal(resolveOverrideSave(" padded ", "runtime text"), " padded ");
});
