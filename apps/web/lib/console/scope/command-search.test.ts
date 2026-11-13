import assert from "node:assert/strict";
import { test } from "node:test";
import { type SearchCommand, searchCommands } from "@/lib/console/scope/command-search";

const commands: SearchCommand[] = [
  {
    id: "traces",
    label: "Traces",
    group: "Observability",
    href: "/project/project-1/traces",
    keywords: ["runs", "spans"],
  },
  {
    id: "settings",
    label: "Project settings",
    group: "Project",
    href: "/project/project-1/settings",
    keywords: ["configure"],
  },
];

test("command search preserves navigation order when the query is empty", () => {
  assert.deepEqual(searchCommands(commands, "   "), commands);
});

test("command search matches labels without case or surrounding whitespace", () => {
  assert.deepEqual(searchCommands(commands, "  TRACE  "), [commands[0]]);
});

test("command search can combine terms from a command group and keywords", () => {
  assert.deepEqual(searchCommands(commands, "project configure"), [commands[1]]);
});

test("command search ranks a label match ahead of a keyword match", () => {
  const runs: SearchCommand = {
    id: "runs",
    label: "Runs",
    group: "Observability",
    href: "/project/project-1/runs",
  };

  assert.deepEqual(searchCommands([commands[0], runs], "runs"), [runs, commands[0]]);
});
