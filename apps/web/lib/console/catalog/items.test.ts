import assert from "node:assert/strict";
import { test } from "node:test";
import { buildToolsCatalog } from "@/lib/synthesis/catalog/tools";
import {
  isoOrNull,
  overrideKey,
  primarySource,
  skillTransitions,
  summarizeTools,
  transitionStatus,
  undoTransition,
  withRuntimeOverrides,
  withSkillRecords,
} from "./items";
import {
  observedTool,
  runtimeDefinition,
  skillItems,
  skillRecord,
  syncedTool,
  toolItems,
} from "./test-support";

test("a managed tool reads its text from the runtime and its usage from traces", () => {
  const [ripgrep] = toolItems({
    observed: [observedTool("ripgrep", 12)],
    definitions: [
      runtimeDefinition("ripgrep", { description: "Search a working tree.", tags: ["code"] }),
    ],
  });
  assert.equal(ripgrep.key, "tool:ripgrep");
  assert.equal(ripgrep.provenance, "managed");
  assert.equal(ripgrep.agentDescription, "Search a working tree.");
  assert.deepEqual(
    ripgrep.searchable && {
      text: ripgrep.searchable.text,
      origin: ripgrep.searchable.origin,
      editable: ripgrep.searchable.editable,
    },
    { text: "Search a working tree.", origin: "agent", editable: true },
  );
  assert.equal(ripgrep.calls, 12);
  assert.equal(ripgrep.callsEstimated, true, "trace counts are estimates");
  assert.equal(ripgrep.tokens, 1440);
  assert.equal(ripgrep.lastSeenAt, "2026-10-09T12:23:35.578Z");
  assert.deepEqual(ripgrep.definition?.tags, ["code"]);
});

test("a Cloud copy wins over the runtime's text, and a runtime's own wording reads as its own", () => {
  const items = toolItems({
    definitions: [
      runtimeDefinition("test_runner", {
        searchableDescriptionOverride: "Run tests, a suite or one spec.",
      }),
      runtimeDefinition("github_api", {
        searchableDescription: "pull requests issues reviews",
        searchableDescriptionOverridden: true,
      }),
    ],
  });
  const runner = items.find((item) => item.name === "test_runner");
  const github = items.find((item) => item.name === "github_api");
  assert.equal(runner?.searchable?.text, "Run tests, a suite or one spec.");
  assert.equal(runner?.searchable?.origin, "cloud");
  assert.deepEqual(runner?.searchable?.target, {
    type: "runtime",
    kind: "tool",
    entryId: "test_runner",
    runtimeText: "Does test_runner.",
    override: "Run tests, a suite or one spec.",
    useCloudDefinitions: false,
  });
  assert.equal(github?.searchable?.origin, "runtime");
});

test("an observed tool has usage but nothing to search on or edit", () => {
  const [lookup] = toolItems({ observed: [observedTool("lookup_order", 45)] });
  assert.equal(lookup.provenance, "observed");
  assert.equal(lookup.searchable, null);
  assert.equal(lookup.agentDescription, null);
  assert.equal(lookup.definition, null);
  assert.equal(lookup.calls, 45);
});

test("a managed tool is read only when the flag that saves overrides is off", () => {
  const [item] = toolItems({ definitions: [runtimeDefinition("ripgrep")], editable: false });
  assert.equal(item.searchable?.editable, false);
});

test("the freshest live source is where a tool comes from", () => {
  const sources = [
    syncedTool("t", "abandoned", {
      sourceStatus: "stale",
      sourceLastSeenAt: new Date("2026-10-15T11:59:00Z"),
    }),
    syncedTool("t", "worker-b", { sourceLastSeenAt: new Date("2026-10-15T10:00:00Z") }),
    syncedTool("t", "worker-a", { sourceLastSeenAt: new Date("2026-10-15T11:00:00Z") }),
  ];
  assert.equal(primarySource(sources), "worker-a");
  assert.equal(primarySource([]), null);
});

test("Cloud skills carry their status, record and own searchable text; runtime and observed skills do not", () => {
  const items = skillItems({
    skills: [
      skillRecord("review-pull-request", { searchableDescription: "review a PR diff", version: 3 }),
      skillRecord("write-unit-tests", { status: "draft" }),
    ],
    runtimeSkills: [
      runtimeDefinition("triage-incident", { entryId: "triage-incident" }),
      {
        entryId: null,
        name: "legacy-skill",
        provenance: "observed",
        lastSeenAt: new Date("2026-10-02T00:00:00Z"),
      },
    ],
    runs: {
      "review-pull-request": { runs: 5, lastRunAt: "2026-10-09T10:00:00.000Z" },
      "legacy-skill": { runs: 2, lastRunAt: null },
    },
  });
  const [review, tests, triage, legacy] = items;
  assert.equal(review.key, "skill:id-review-pull-request");
  assert.equal(review.status, "published");
  assert.equal(review.runs, 5);
  assert.equal(review.searchable?.origin, "cloud");
  assert.deepEqual(review.searchable?.target, {
    type: "skill",
    skillId: "id-review-pull-request",
    version: 3,
    stored: "review a PR diff",
  });
  assert.equal(tests.status, "draft");
  assert.equal(
    tests.searchable?.text,
    "Use write-unit-tests.",
    "no own text: matched on the description",
  );
  assert.equal(tests.searchable?.origin, "agent");
  assert.equal(triage.provenance, "managed");
  assert.equal(triage.key, "skill:triage-incident");
  assert.equal(triage.searchable?.target.type, "runtime");
  assert.equal(legacy.provenance, "observed");
  assert.equal(legacy.key, "skill:legacy-skill");
  assert.equal(legacy.searchable, null);
  assert.equal(legacy.runs, 2);
  assert.equal(
    legacy.lastSeenAt,
    "2026-10-02T00:00:00.000Z",
    "no run time: falls back to when traces last saw it",
  );
});

test("a Cloud skill shows no searchable description until the field is rolled out", () => {
  const [item] = skillItems({ skills: [skillRecord("deploy-service")], searchableEnabled: false });
  assert.equal(item.searchable, null);
  assert.equal(item.agentDescription, "Use deploy-service.");
});

test("saved Cloud copies apply to their entry only", () => {
  const entries = [runtimeDefinition("a"), runtimeDefinition("b")];
  const next = withRuntimeOverrides(
    entries,
    "tool",
    new Map([[overrideKey("tool", "a"), "new text"]]),
  );
  assert.equal(next[0].searchableDescriptionOverride, "new text");
  assert.equal(next[1], entries[1], "an untouched entry keeps its identity");
  assert.equal(entries[0].searchableDescriptionOverride, null, "the input is not mutated");
  const cleared = withRuntimeOverrides(next, "tool", new Map([[overrideKey("tool", "a"), null]]));
  assert.equal(cleared[0].searchableDescriptionOverride, null);
  assert.equal(
    withRuntimeOverrides(entries, "skill", new Map([[overrideKey("tool", "a"), "x"]]))[0],
    entries[0],
    "kinds do not mix",
  );
});

test("a local skill record applies until the server has a newer one", () => {
  const server = [skillRecord("a", { version: 2, status: "published" })];
  const local = skillRecord("a", { version: 3, status: "archived" });
  assert.equal(withSkillRecords(server, new Map([[local.id, local]]))[0].status, "archived");
  const newer = [skillRecord("a", { version: 4, status: "draft" })];
  assert.equal(withSkillRecords(newer, new Map([[local.id, local]]))[0].status, "draft");
});

test("publish and archive move between states, and only an exact way back is an Undo", () => {
  assert.deepEqual(skillTransitions("draft"), ["publish", "archive"]);
  assert.deepEqual(skillTransitions("published"), ["archive"]);
  assert.deepEqual(skillTransitions("archived"), ["publish"]);
  assert.deepEqual(skillTransitions(null), []);
  assert.equal(transitionStatus("publish"), "published");
  assert.equal(undoTransition("published", "archived"), "publish");
  assert.equal(undoTransition("archived", "published"), "archive");
  assert.equal(undoTransition("draft", "archived"), null, "nothing returns a skill to draft");
  assert.equal(undoTransition("draft", "published"), null);
});

test("totals prefer exact calls from synced sources and sum trace usage", () => {
  const traced = buildToolsCatalog([observedTool("a", 10), observedTool("b", 5)]);
  assert.deepEqual(summarizeTools(traced), {
    tools: 2,
    calls: 15,
    callsExact: false,
    tokens: 1800,
    costUsd: 0.015,
    observed: true,
  });
  const exact = buildToolsCatalog(
    [observedTool("a", 10), observedTool("b", 5)],
    [syncedTool("a", "worker", { factsStartedAt: new Date("2026-10-01T00:00:00Z"), calls: 7 })],
  );
  const totals = summarizeTools(exact);
  assert.equal(totals.calls, 7, "the estimate for b is left out rather than mixed in");
  assert.equal(totals.callsExact, true);
  assert.deepEqual(summarizeTools([]), {
    tools: 0,
    calls: 0,
    callsExact: false,
    tokens: 0,
    costUsd: 0,
    observed: false,
  });
});

test("dates cross the server boundary as Dates or strings", () => {
  assert.equal(isoOrNull(new Date("2026-10-09T12:00:00Z")), "2026-10-09T12:00:00.000Z");
  assert.equal(isoOrNull("2026-10-09T12:00:00Z"), "2026-10-09T12:00:00.000Z");
  assert.equal(isoOrNull(null), null);
  assert.equal(isoOrNull("not a date"), null);
});
