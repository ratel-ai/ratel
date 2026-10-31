import assert from "node:assert/strict";
import { test } from "node:test";
import { CRAFT_KINDS } from "@/lib/views/fixes/crafter-types";
import {
  CRAFT_FIX_KIND,
  FIX_KIND_LABELS,
  FIX_KINDS,
  issueFixKind,
  parseFixKind,
  resolvesIssue,
} from "@/lib/views/fixes/kinds";

/** Words the product never shows (DESIGN.md, The product's nouns). */
const FORBIDDEN = /workflow|tool craft|suggestion|proposal|signal|craft|jev|bm25|\u2014/i;

test("every drafted change maps to one plain kind of fix", () => {
  for (const kind of CRAFT_KINDS) {
    const fix = CRAFT_FIX_KIND[kind];
    assert.ok(FIX_KINDS.includes(fix), `${kind} maps to ${fix}`);
  }
});

test("kind labels are plain, sentence case and free of engine words", () => {
  for (const kind of FIX_KINDS) {
    const label = FIX_KIND_LABELS[kind];
    assert.ok(label.length > 0);
    assert.equal(label[0], label[0]!.toUpperCase(), label);
    assert.equal(label.slice(1), label.slice(1).toLowerCase(), `${label} is sentence case`);
    assert.doesNotMatch(label, FORBIDDEN, label);
  }
  assert.equal(FIX_KIND_LABELS.rewrite, "Rewrite a description");
  assert.equal(FIX_KIND_LABELS.retire, "Retire a tool");
  assert.equal(FIX_KIND_LABELS["fail-clearly"], "Make a tool fail clearly");
});

test("the kind in the URL is read strictly", () => {
  assert.equal(parseFixKind("rewrite"), "rewrite");
  assert.equal(parseFixKind(["merge", "retire"]), "merge");
  assert.equal(parseFixKind("rewrite_tool"), null);
  assert.equal(parseFixKind(undefined), null);
  assert.equal(parseFixKind(""), null);
});

test("an issue's own fix follows its route, and only concrete changes count", () => {
  assert.equal(
    issueFixKind({ kind: "magnet", route: "rewrite_description", toolIds: ["a"], fix: "" }),
    "rewrite",
  );
  assert.equal(
    issueFixKind({ kind: "first_try_miss", route: "rewrite_description", toolIds: ["a"], fix: "" }),
    "rewrite",
  );
  // Ranking a tool higher is Ratel's own job, never a change the customer makes.
  assert.equal(
    issueFixKind({ kind: "first_try_miss", route: "adaptive_ranking", toolIds: ["a"], fix: "" }),
    null,
  );
  assert.equal(
    issueFixKind({ kind: "buried_tool", route: "adaptive_ranking", toolIds: ["a"], fix: "" }),
    null,
  );
  assert.equal(
    issueFixKind({ kind: "dead_tool", route: "retire_tool", toolIds: ["a", "b"], fix: "" }),
    "retire",
  );
  assert.equal(
    issueFixKind({ kind: "sequence_chain", route: "workflow_skill", toolIds: ["a", "b"], fix: "" }),
    "skill",
  );
  assert.equal(
    issueFixKind({ kind: "sequence_chain", route: "none", toolIds: ["a", "b"], fix: "" }),
    null,
  );
  assert.equal(
    issueFixKind({
      kind: "sibling_confusion",
      route: "disambiguate_pair",
      toolIds: ["a", "b"],
      fix: "",
    }),
    "tell-apart",
  );
  assert.equal(
    issueFixKind({ kind: "padding_share", route: "lower_top_k", toolIds: [], fix: "" }),
    "fewer-results",
  );
  // A project-wide rewrite with no tool to rewrite is not a change anyone can make.
  assert.equal(
    issueFixKind({ kind: "padding_share", route: "rewrite_description", toolIds: [], fix: "" }),
    null,
  );
  assert.equal(
    issueFixKind({ kind: "identical_retry", route: "show_turns", toolIds: ["a"], fix: "" }),
    "fail-clearly",
  );
  assert.equal(
    issueFixKind({ kind: "unknown_tool", route: "show_turns", toolIds: ["a"], fix: "" }),
    "build",
  );
  assert.equal(
    issueFixKind({
      kind: "workflow_fixed_chain",
      route: "workflow_skill",
      toolIds: ["a", "b", "c"],
      fix: "",
    }),
    "combine",
  );
  // "Look at these turns" and "nothing to change" are not fixes.
  for (const kind of [
    "error_loop",
    "latency_outlier",
    "wait_heavy",
    "abandoned_search",
    "long_turn",
    "workflow_failing",
    "workflow_slow",
  ]) {
    assert.equal(
      issueFixKind({ kind, route: "show_turns", toolIds: ["a"], fix: "Look at these turns." }),
      null,
      kind,
    );
  }
});

test("a kind this build does not know is read from its route, then from its fix sentence", () => {
  assert.equal(
    issueFixKind({
      kind: "self_correcting",
      route: "rewrite_description",
      toolIds: ["a"],
      fix: "",
    }),
    "rewrite",
  );
  assert.equal(
    issueFixKind({
      kind: "self_correcting",
      route: null,
      toolIds: ["lookup_order"],
      fix: "Make lookup_order fail with a clear message.",
    }),
    "fail-clearly",
  );
  assert.equal(
    issueFixKind({
      kind: "self_correcting",
      route: null,
      toolIds: ["a"],
      fix: "Rewrite a's searchable description with the words people use.",
    }),
    "rewrite",
  );
  assert.equal(
    issueFixKind({
      kind: "self_correcting",
      route: null,
      toolIds: [],
      fix: "Add a skill that walks the agent through refunds.",
    }),
    "skill",
  );
  assert.equal(
    issueFixKind({
      kind: "self_correcting",
      route: null,
      toolIds: [],
      fix: "Build a tool or add a skill for refunds.",
    }),
    "build",
  );
  assert.equal(
    issueFixKind({
      kind: "self_correcting",
      route: null,
      toolIds: ["a"],
      fix: "Look at these turns.",
    }),
    null,
  );
});

test("a drafted change resolves the issues about the same thing", () => {
  const rewrite = { kind: "rewrite" as const, toolIds: ["a"], taskIds: [] as string[] };
  assert.equal(
    resolvesIssue(rewrite, { kind: "magnet", subjectKind: "tool", toolIds: ["a"], taskId: null }),
    true,
  );
  assert.equal(
    resolvesIssue(rewrite, { kind: "magnet", subjectKind: "tool", toolIds: ["b"], taskId: null }),
    false,
  );
  assert.equal(
    resolvesIssue(rewrite, {
      kind: "error_loop",
      subjectKind: "tool",
      toolIds: ["a"],
      taskId: null,
    }),
    false,
  );
  // A pair is resolved by a rewrite of either side, and by a merge of both.
  assert.equal(
    resolvesIssue(rewrite, {
      kind: "sibling_confusion",
      subjectKind: "tool_pair",
      toolIds: ["a", "b"],
      taskId: null,
    }),
    true,
  );
  const merge = { kind: "merge" as const, toolIds: ["a", "b"], taskIds: [] };
  assert.equal(
    resolvesIssue(merge, {
      kind: "sequence_chain",
      subjectKind: "tool_pair",
      toolIds: ["a", "b"],
      taskId: null,
    }),
    true,
  );
  assert.equal(
    resolvesIssue(merge, {
      kind: "sequence_chain",
      subjectKind: "tool_pair",
      toolIds: ["a", "c"],
      taskId: null,
    }),
    false,
  );
  // A task's fixed chain is resolved by combining that task's steps.
  const combine = { kind: "combine" as const, toolIds: ["a", "b", "c"], taskIds: ["wf_1"] };
  assert.equal(
    resolvesIssue(combine, {
      kind: "workflow_fixed_chain",
      subjectKind: "workflow",
      toolIds: ["a", "b", "c"],
      taskId: "wf_1",
    }),
    true,
  );
  assert.equal(
    resolvesIssue(combine, {
      kind: "workflow_fixed_chain",
      subjectKind: "workflow",
      toolIds: ["x", "y"],
      taskId: "wf_2",
    }),
    false,
  );
  // Retiring one tool resolves the "tools nobody uses" issue that names it.
  const retire = { kind: "retire" as const, toolIds: ["b"], taskIds: [] };
  assert.equal(
    resolvesIssue(retire, {
      kind: "dead_tool",
      subjectKind: "project",
      toolIds: ["a", "b", "c"],
      taskId: null,
    }),
    true,
  );
  // Schema and error fixes resolve the failures on their tool.
  const schema = { kind: "schema" as const, toolIds: ["a"], taskIds: [] };
  assert.equal(
    resolvesIssue(schema, {
      kind: "error_loop",
      subjectKind: "tool",
      toolIds: ["a"],
      taskId: null,
    }),
    true,
  );
  assert.equal(
    resolvesIssue(schema, {
      kind: "identical_retry",
      subjectKind: "tool",
      toolIds: ["a"],
      taskId: null,
    }),
    true,
  );
});
