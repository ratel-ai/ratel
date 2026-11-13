import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySkillDraft,
  applyToolDraft,
  editedIds,
  skillIsEdited,
  summarizeChanges,
  toolIsEdited,
} from "./bench";
import { BENCH_SKILL_DEFAULTS, BENCH_TOOL_DEFAULTS } from "./test-support";
import type { BenchSkill, BenchTool, DraftsByKind } from "./types";

const skill = (over: Partial<BenchSkill> = {}): BenchSkill => ({
  ...BENCH_SKILL_DEFAULTS,
  id: "uuid-1",
  name: "review-pull-request",
  description: "Review a pull request and flag risky changes.",
  tags: ["git", "review"],
  tools: ["github_api"],
  status: "published",
  version: 3,
  ...over,
});

const tool = (over: Partial<BenchTool> = {}): BenchTool => ({
  ...BENCH_TOOL_DEFAULTS,
  name: "github_api",
  description: "Read and write GitHub pull requests.",
  hasDefinition: true,
  calls: 12,
  ...over,
});

const drafts = (over: Partial<DraftsByKind> = {}): DraftsByKind => ({
  skill: {},
  tool: {},
  ...over,
});

test("applySkillDraft overlays only the fields the draft sets", () => {
  const drafted = applySkillDraft(skill(), { description: "New prose." });
  assert.equal(drafted.description, "New prose.");
  assert.deepEqual(drafted.tags, ["git", "review"]);
  assert.equal(drafted.version, 3);
});

test("a whitespace-only draft means no edit, not an empty description", () => {
  // Clearing the textarea should fall back to the stored text rather than
  // silently ranking the capability on nothing.
  const drafted = applySkillDraft(skill(), { description: "   " });
  assert.equal(drafted.description, skill().description);
  assert.equal(skillIsEdited(skill(), { description: "   " }), false);
});

test("a draft equal to the baseline is not an edit", () => {
  const base = skill();
  assert.equal(skillIsEdited(base, { description: base.description }), false);
  assert.equal(skillIsEdited(base, undefined), false);
  assert.equal(skillIsEdited(base, { description: "Different." }), true);
});

test("tag order counts as an edit, since the index sees a different list", () => {
  assert.equal(skillIsEdited(skill(), { tags: ["review", "git"] }), true);
  assert.equal(skillIsEdited(skill(), { tags: ["git", "review"] }), false);
});

test("applyToolDraft overlays the description and nothing else", () => {
  const drafted = applyToolDraft(tool(), { description: "Hypothetical." });
  assert.equal(drafted.description, "Hypothetical.");
  assert.equal(drafted.hasDefinition, true);
  assert.equal(drafted.calls, 12);
  assert.equal(toolIsEdited(tool(), { description: "Hypothetical." }), true);
  assert.equal(toolIsEdited(tool(), undefined), false);
});

test("summarizeChanges reports field-level before/after for real edits only", () => {
  const changes = summarizeChanges(
    [skill(), skill({ id: "uuid-2", name: "write-unit-tests" })],
    [tool()],
    drafts({
      skill: {
        "review-pull-request": { description: "Sharper prose.", tags: ["git"] },
        // Same text as stored, so it must not appear as a change.
        "write-unit-tests": { description: skill().description },
      },
      tool: { github_api: { description: "What if it said this?" } },
    }),
  );

  assert.equal(changes.length, 2);
  const [skillChange, toolChange] = changes;
  assert.equal(skillChange.kind, "skill");
  assert.equal(skillChange.id, "review-pull-request");
  assert.deepEqual(
    skillChange.changes.map((change) => change.field),
    ["description", "tags"],
  );
  assert.equal(skillChange.changes[0].before, skill().description);
  assert.equal(skillChange.changes[0].after, "Sharper prose.");
  assert.equal(skillChange.changes[1].before, "git, review");
  assert.equal(skillChange.changes[1].after, "git");
  assert.equal(toolChange.kind, "tool");
  assert.equal(toolChange.id, "github_api");
});

test("editedIds collects only the capabilities that actually differ", () => {
  const edited = editedIds(
    [skill()],
    [tool(), tool({ name: "ripgrep" })],
    drafts({
      skill: { "review-pull-request": { description: "   " } },
      tool: { ripgrep: { description: "Search the repo." } },
    }),
  );
  assert.deepEqual([...edited.skills], []);
  assert.deepEqual([...edited.tools], ["ripgrep"]);
});

test("summarizeChanges returns nothing when there are no drafts", () => {
  assert.deepEqual(summarizeChanges([skill()], [tool()], drafts()), []);
});

test("a trailing space survives, because the box is controlled by this value", () => {
  // Trimming here deleted the space the instant it was pressed: the textarea's
  // value comes straight from applySkillDraft, so a trim on every keystroke is
  // a keystroke the reader cannot make.
  const drafted = applySkillDraft(skill(), { description: "Review a diff " });
  assert.equal(drafted.description, "Review a diff ");

  const tool = applyToolDraft(
    {
      ...BENCH_TOOL_DEFAULTS,
      name: "ripgrep",
      description: "Search.",
      hasDefinition: true,
      calls: 1,
    },
    { description: "Search the repo " },
  );
  assert.equal(tool.description, "Search the repo ");
});

test("whitespace alone is not an edit, so a stray space raises no unsaved count", () => {
  const base = skill();
  const padded = { description: `  ${base.description}  ` };
  assert.equal(skillIsEdited(base, padded), false);
  assert.deepEqual(summarizeChanges([base], [], drafts({ skill: { [base.name]: padded } })), []);
  // …but the padded text is still what the box shows while it is being typed.
  assert.equal(applySkillDraft(base, padded).description, `  ${base.description}  `);
});

test("a real edit with a trailing space still counts as an edit", () => {
  const base = skill();
  assert.equal(skillIsEdited(base, { description: "Something else " }), true);
});

/* — Drafts edit the text retrieval reads ————————————————————————————————————— */

/**
 * The invariant that makes the bench honest: whatever you type is what the next
 * run matches on. Which COLUMN that lands in depends on the capability — a
 * managed entry keeps its match text in the searchable description, a plain one
 * has only the description — but the promise to the reader is the same either
 * way, and these tests are what stop the two cases drifting apart.
 */

const MANAGED_TOOL: BenchTool = {
  ...BENCH_TOOL_DEFAULTS,
  name: "calendar_create",
  description: "Persists an ICS entity to the organizer backend.",
  entryId: "calendar.create",
  searchableDescription: "schedule a meeting",
  hasDefinition: true,
  calls: 4,
};

test("a draft on a managed tool changes the retrieval text, not the agent's", () => {
  const drafted = applyToolDraft(MANAGED_TOOL, {
    description: "reserve a conference room",
  });
  assert.equal(
    drafted.searchableDescriptionOverride,
    "reserve a conference room",
    "the edit lands where an override would be saved",
  );
  assert.equal(
    drafted.description,
    MANAGED_TOOL.description,
    "what the agent receives is untouched — Ratel does not own it",
  );
  assert.equal(toolIsEdited(MANAGED_TOOL, { description: "reserve a room" }), true);
});

test("a draft matching the retrieval text is not an edit, whichever field holds it", () => {
  assert.equal(toolIsEdited(MANAGED_TOOL, { description: "  schedule a meeting  " }), false);
  // Typing the AGENT description into a managed tool IS an edit: it would
  // change what the tool matches on, which is the whole point of the box.
  assert.equal(toolIsEdited(MANAGED_TOOL, { description: MANAGED_TOOL.description }), true);
});

test("a tool with no searchable description has its one description edited", () => {
  const observed = tool({ searchableDescription: null, entryId: null });
  const drafted = applyToolDraft(observed, { description: "New prose." });
  assert.equal(drafted.description, "New prose.");
  assert.equal(drafted.searchableDescriptionOverride, null);
});

test("the same split holds for skills", () => {
  const managed = skill({ searchableDescription: "page the on-call" });
  const drafted = applySkillDraft(managed, { description: "escalate an outage" });
  assert.equal(drafted.searchableDescription, "escalate an outage");
  assert.equal(drafted.description, managed.description);

  const plain = skill({ searchableDescription: null });
  assert.equal(applySkillDraft(plain, { description: "New prose." }).description, "New prose.");
});

test("the change summary diffs the retrieval text, so it matches what ran", () => {
  const [change] = summarizeChanges(
    [],
    [MANAGED_TOOL],
    drafts({ tool: { calendar_create: { description: "reserve a room" } } }),
  );
  assert.deepEqual(change.changes, [
    {
      field: "description",
      before: "schedule a meeting",
      after: "reserve a room",
    },
  ]);
});
