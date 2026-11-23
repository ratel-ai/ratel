import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchableTarget } from "./items";
import { cloudSkillSearchable, runtimeSearchable } from "./items";
import {
  adoptionNotice,
  matchesAgentDescription,
  planSearchableReset,
  planSearchableSave,
  storedValue,
  targetAfterWrite,
} from "./searchable";
import { runtimeDefinition, skillRecord } from "./test-support";

const runtime = (override: string | null = null): SearchableTarget => ({
  type: "runtime",
  kind: "tool",
  entryId: "ripgrep",
  runtimeText: "Search a working tree.",
  override,
  useCloudDefinitions: false,
});

const skill = (stored: string | null = null): SearchableTarget => ({
  type: "skill",
  skillId: "s1",
  version: 4,
  stored,
});

test("a new text on a runtime entry is stored as its Ratel copy, trimmed", () => {
  assert.deepEqual(
    planSearchableSave(runtime(), "Search a working tree.", "  grep regex search files  "),
    {
      type: "write",
      stored: "grep regex search files",
      previous: null,
    },
  );
});

test("emptying the field or typing the runtime's own text back clears the Ratel copy", () => {
  assert.deepEqual(planSearchableSave(runtime("old copy"), "x", "   "), {
    type: "write",
    stored: null,
    previous: "old copy",
  });
  assert.deepEqual(planSearchableSave(runtime("old copy"), "x", "Search a working tree. "), {
    type: "write",
    stored: null,
    previous: "old copy",
  });
});

test("saving what is already stored writes nothing", () => {
  assert.deepEqual(planSearchableSave(runtime("same"), "x", "same"), { type: "noop" });
  assert.deepEqual(
    planSearchableSave(runtime(), "x", ""),
    { type: "noop" },
    "nothing stored and nothing typed",
  );
  assert.deepEqual(planSearchableSave(skill("kept"), "Use it.", " kept "), { type: "noop" });
});

test("a Ratel skill stores its own text, and its description back means none", () => {
  assert.deepEqual(planSearchableSave(skill(), "Review a pull request.", "review PR diff"), {
    type: "write",
    stored: "review PR diff",
    previous: null,
  });
  assert.deepEqual(
    planSearchableSave(skill("review PR diff"), "Review a pull request.", "Review a pull request."),
    {
      type: "write",
      stored: null,
      previous: "review PR diff",
    },
  );
});

test("an oversized text is refused before it reaches the route", () => {
  const plan = planSearchableSave(skill(), "d", "x".repeat(4097));
  assert.equal(plan.type, "invalid");
  assert.match(plan.type === "invalid" ? plan.error : "", /4,096 characters/);
});

test("reset clears a runtime entry's Ratel copy and does nothing elsewhere", () => {
  assert.deepEqual(planSearchableReset(runtime("copy")), {
    type: "write",
    stored: null,
    previous: "copy",
  });
  assert.deepEqual(planSearchableReset(runtime()), { type: "noop" });
  assert.deepEqual(planSearchableReset(skill("own")), { type: "noop" });
});

test("after a write the target carries the new value and version, so Undo starts from it", () => {
  assert.equal(storedValue(targetAfterWrite(runtime(), "new")), "new");
  assert.deepEqual(targetAfterWrite(skill("a"), null, 5), {
    type: "skill",
    skillId: "s1",
    version: 5,
    stored: null,
  });
  assert.deepEqual(targetAfterWrite(skill("a"), "b"), {
    type: "skill",
    skillId: "s1",
    version: 4,
    stored: "b",
  });
});

test("the agent description is only repeated when it differs", () => {
  const same = runtimeSearchable("tool", runtimeDefinition("a", { description: "Same." }), true);
  assert.equal(matchesAgentDescription(same, "Same. "), true);
  assert.equal(matchesAgentDescription(same, "Other."), false);
  assert.equal(matchesAgentDescription(same, null), false);
});

test("an adoption notice appears only for a Ratel copy the runtime has not confirmed", () => {
  const plain = runtimeSearchable("tool", runtimeDefinition("a"), true);
  assert.equal(adoptionNotice(plain, null), null, "no Ratel copy, nothing to adopt");
  const copied = runtimeSearchable(
    "tool",
    runtimeDefinition("a", { searchableDescriptionOverride: "copy" }),
    true,
  );
  assert.equal(adoptionNotice(copied, null), "may-use-own-copy");
  assert.equal(adoptionNotice(copied, true), null, "a recent override pull is proof");
  const flagged = runtimeSearchable(
    "tool",
    runtimeDefinition("a", { searchableDescriptionOverride: "copy", useCloudDefinitions: true }),
    true,
  );
  assert.equal(adoptionNotice(flagged, null), null, "the runtime says it reads Ratel definitions");
  const skillCopy = runtimeSearchable(
    "skill",
    runtimeDefinition("s", { searchableDescriptionOverride: "copy" }),
    true,
  );
  assert.equal(
    adoptionNotice(skillCopy, false),
    "still-own-copy",
    "skills can prove the runtime is behind",
  );
  assert.equal(
    adoptionNotice(cloudSkillSearchable(skillRecord("x", { searchableDescription: "own" })), false),
    null,
    "a Ratel skill is not a runtime copy",
  );
});
