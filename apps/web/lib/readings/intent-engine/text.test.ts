import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanAskText,
  identifierWords,
  maskArguments,
  toolFamily,
  VerbLexicon,
} from "@/lib/readings/intent-engine/text";

test("maskArguments: values that differ only by the record they name read the same", () => {
  assert.equal(
    maskArguments("assign this task to emp-1").masked,
    maskArguments("assign this task to emp-22").masked,
  );
  assert.equal(maskArguments("assign this task to emp-1").masked, "assign this task to {id}");
});

test("maskArguments: urls, emails, quoted strings, paths and identifiers", () => {
  const { masked, slots } = maskArguments(
    'email jane@acme.io the report at https://x.io/a?b=1 about "Q3 revenue" in src/app/page.tsx for fetchWithTimeout',
  );
  assert.equal(masked, "email {email} the report at {url} about {value} in {path} for {id}");
  assert.deepEqual([...slots].sort(), ["email", "id", "path", "url", "value"]);
});

test("maskArguments: slash words and contractions stay words", () => {
  assert.equal(
    maskArguments("compare client/server and/or don't").masked,
    "compare client/server and/or don't",
  );
});

test("cleanAskText drops fenced code and caps length", () => {
  assert.equal(cleanAskText("fix this\n```\nstack trace\n```\nplease"), "fix this please");
  assert.equal(cleanAskText("```only code```"), "");
  assert.equal(cleanAskText("a".repeat(50), 10).length, 10);
});

test("identifierWords and toolFamily", () => {
  assert.deepEqual(identifierWords("createIssue"), ["create", "issue"]);
  assert.deepEqual(identifierWords("github__create_issue"), ["github", "create", "issue"]);
  assert.equal(toolFamily("github__create_issue"), "github");
  assert.equal(toolFamily("mcp__jira__search"), "jira");
  assert.equal(toolFamily("search_tasks"), null);
});

test("VerbLexicon: base verbs, verbs learned from tools, objects", () => {
  const verbs = new VerbLexicon();
  assert.equal(verbs.startsWithVerb("check the CI tests"), true);
  assert.equal(verbs.startsWithVerb("the failed ones"), false);
  verbs.learnTool("jira__transition_issue");
  assert.equal(
    verbs.startsWithVerb("transition the issue"),
    false,
    "a noun-like lead word is not learned",
  );
  verbs.learnTool("triage_alerts");
  assert.equal(verbs.startsWithVerb("triage alerts"), true);
  assert.deepEqual(verbs.objectTerms("fix the CI tests"), ["ci", "test"]);
});

test("actionHeads counts the actions an ask asks for", async () => {
  const { actionHeads, VerbLexicon } = await import("@/lib/readings/intent-engine/text");
  const v = new VerbLexicon();
  for (const t of ["create_task", "add_task_comment", "list_tasks"]) v.learnTool(t);
  const cases: Array<[string, number]> = [
    ["create task comment on task list tasks in project", 3],
    ["create_document find_documents", 2],
    ["Find documents by title and search projects by name", 2],
    ["add comment on task", 1],
    ["delete or remove a task relationship", 1],
    ["update task status and description", 1],
    ["find project by name to create a task in it", 1],
    ["check the CI tests on main", 1],
    ["create_task with parentTaskId description status", 1],
    // A generic domain: nothing here is tuned to one customer.
    ["refund the order and notify the customer", 2],
    ["show open invoices for acme", 1],
  ];
  for (const [text, n] of cases) assert.equal(actionHeads(text, v), n, text);
});
