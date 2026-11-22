import assert from "node:assert/strict";
import { test } from "node:test";
import type { Organization } from "@/lib/platform/organizations";
import { buildFixes } from "@/lib/views/fixes/build";
import { CRAFTS, fixesInput } from "@/lib/views/fixes/test-fixtures";
import { fixMarker } from "../marker";
import { type LoadBriefDeps, loadHandoffBrief } from "./load-brief";

const ORG = { id: "org-1" } as Organization;

/**
 * Owned (ADR-0030): the drafted changes here are `DraftFixInput` fixtures, whose copy is not the
 * crafter's prompt, so the merge draft carries the crafter's opening line as its copy.
 */
const PROMPT =
  "## Problem\nRatel suggests a change to this agent's tools: Merge find_task and assign_task";
const DRAFTS = CRAFTS.map((draft) =>
  draft.id === "c-merge" ? { ...draft, copy: { label: "Copy prompt", text: PROMPT } } : draft,
);
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

function deps(over: Partial<LoadBriefDeps> = {}): LoadBriefDeps & { calls: string[] } {
  const calls: string[] = [];
  const model = buildFixes(fixesInput({ drafts: DRAFTS }));
  return {
    calls,
    loadFixes: async () => model,
    codePointers: async () => [
      { kind: "tool", symbol: "find_task", path: "src/tools/tasks.ts", line: 12 },
      { kind: "tool", symbol: "unrelated_tool", path: "src/tools/other.ts", line: 3 },
      { kind: "model", symbol: "claude-sonnet-5-5", path: "src/agent.ts", line: 7 },
    ],
    exampleTraceIds: async (_projectId, _org, issueIds) => {
      calls.push(`examples:${issueIds.join(",")}`);
      return [TRACE];
    },
    evalSet: async (_projectId, fixId) => {
      calls.push(`evalSet:${fixId}`);
      return null;
    },
    consoleBaseUrl: () => "https://cloud.ratel.sh",
    ...over,
  };
}

test("loads the brief of a drafted fix with its prompt, its own pointers and example traces", async () => {
  const fake = deps();
  const loaded = await loadHandoffBrief(
    { projectId: "p1", organization: ORG, fixId: "craft:c-merge" },
    fake,
  );
  assert.ok(loaded);
  assert.equal(loaded.fix.kind, "merge");
  assert.ok(loaded.brief.includes("src/tools/tasks.ts:12 find_task"), "its tool's pointer");
  assert.ok(loaded.brief.includes("src/agent.ts:7 claude-sonnet-5-5"), "model pointers always");
  assert.ok(!loaded.brief.includes("unrelated_tool"), "other tools' pointers are left out");
  assert.ok(loaded.brief.includes(`https://cloud.ratel.sh/project/p1/traces/${TRACE}`));
  assert.ok(
    loaded.brief.includes("Ratel suggests a change to this agent's tools"),
    "the drafted change's prompt is embedded",
  );
  assert.ok(!loaded.brief.includes("## Eval set"));
  assert.ok(loaded.brief.trimEnd().endsWith(fixMarker(loaded.fix.id)));
  assert.ok(fake.calls.includes(`evalSet:${loaded.fix.id}`));
});

test("finds a fix by one of its aliases", async () => {
  const model = buildFixes(fixesInput());
  const aliased = [...model.open, ...model.applied].find((fix) => fix.aliases.length > 0);
  assert.ok(aliased, "the fixtures have a fix with an alias");
  const loaded = await loadHandoffBrief(
    { projectId: "p1", organization: ORG, fixId: aliased.aliases[0]! },
    deps(),
  );
  assert.equal(loaded?.fix.id, aliased.id);
});

test("an unknown fix id reads as null", async () => {
  assert.equal(
    await loadHandoffBrief({ projectId: "p1", organization: ORG, fixId: "issue:nope" }, deps()),
    null,
  );
});

test("the eval set is named when the fix has one", async () => {
  const loaded = await loadHandoffBrief(
    { projectId: "p1", organization: ORG, fixId: "craft:c-merge" },
    deps({
      evalSet: async () => ({
        runId: "run-1",
        status: "succeeded",
        evals: [{ name: "Hand a task over", outcome: "fixed" }],
      }),
    }),
  );
  assert.ok(loaded?.brief.includes("## Eval set"));
  assert.ok(loaded?.brief.includes("fixed: Hand a task over"));
});
