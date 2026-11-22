import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { EvalDefinition } from "@/components/console/evals/EvalDefinition";
import { EvalEditor } from "@/components/console/evals/EvalEditor";
import { EvalHeader } from "@/components/console/evals/EvalHeader";
import { SingleTestView } from "@/components/console/evals/SingleTestView";
import { fixedAnswerFromStep, formFromEval, limitHint } from "@/lib/views/evals/domain/edit";
import type { Eval, EvalResult, EvalRun } from "@/lib/views/evals/domain/types";
import type { RunSettingsModel } from "@/lib/views/evals/run-settings";
import { evalRules, testSteps } from "@/lib/views/evals/test-view";
import type { EvalScorerSwitch } from "@/lib/views/scorers/page";
import { SCORER_KINDS, type Scorer, type ScorerKind } from "@/lib/views/task-scorers/types";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";

const AT = new Date("2026-11-08T09:10:00Z");
const ITEM: Eval = {
  id: "e1",
  projectId: PROJECT_ID,
  name: "Aisle seat, after asking about the booking",
  sourceTurnId: "t1",
  sourceCaseId: null,
  message: "Can you move me to an aisle seat?",
  earlierMessages: [
    { role: "user", text: "Hi, what's on my booking MRD4X7?" },
    { role: "tool", tool: "find_booking", args: { ref: "MRD4X7" }, text: '{"seat":"22B"}' },
    { role: "assistant", text: "You fly MR214, seat 22B." },
  ],
  turns: [
    { kind: "message", text: "Is it free?" },
    { kind: "person", description: "A traveler in a hurry who stops after one answer" },
  ],
  checks: { max_latency_ms: { on: true, max: 12_700 } },
  expectedTool: "select_seat",
  criteria: "Says the new seat",
  fixedAnswers: [
    {
      tool: "select_seat",
      result: { seat: "14C", charge: 0 },
      when: { seat: "14C" },
      why: "Seat changes are free on this fare",
    },
  ],
  status: "approved",
  origin: "user",
  tasks: ["wf-1"],
  createdBy: "u",
  createdAt: AT,
  updatedAt: AT,
};
const TASK_SCORERS: Scorer[] = [
  { kind: "ends_well" },
  { kind: "max_cost_usd", max: 0.0177 },
  { kind: "max_latency_ms", max: 20_000 },
];
const HINTS = Object.fromEntries(
  SCORER_KINDS.map((kind) => [kind, limitHint(kind, TASK_SCORERS)]),
) as Record<ScorerKind, string | null>;
const TASKS = [
  { id: "wf-1", label: "Change a seat" },
  { id: "wf-2", label: "Rebook a flight" },
];

const editor = (over: Partial<Parameters<typeof EvalEditor>[0]> = {}) =>
  render(
    createElement(EvalEditor, {
      projectId: PROJECT_ID,
      evalId: ITEM.id,
      message: ITEM.message,
      initial: formFromEval(ITEM, [
        ...TASK_SCORERS,
        { kind: "expected_tool", tool: "select_seat" },
        { kind: "judge_criteria", criteria: "Says the new seat" },
      ]),
      tasks: TASKS,
      tools: ["find_booking", "get_seat_map", "select_seat"],
      hints: HINTS,
      ...over,
    }),
  );
const decoded = (html: string) =>
  visibleText(html)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
const section = (html: string, name: string) => html.slice(html.indexOf(`data-section="${name}"`));

test("RC-297 editor: name, then earlier messages of each kind (RC-657: under Scenario)", () => {
  const html = editor();
  assert.match(html, /value="Aisle seat, after asking about the booking"/);
  const earlier = visibleText(
    section(html, "earlier").slice(0, section(html, "earlier").indexOf('data-section="turns"')),
  );
  assert.match(earlier, /Person/);
  assert.match(earlier, /Tool call/);
  assert.match(earlier, /Agent/);
  assert.match(earlier, /Earlier message/);
  assert.match(earlier, /Earlier tool call/);
  assert.match(html, /value="find_booking"/);
  assert.match(html, /value="\{&quot;ref&quot;:&quot;MRD4X7&quot;\}"/);
  assert.match(html, /Given to the agent as history\. Not replayed, not scored\./);
});

test("RC-297 editor: turn 1 is the message (RC-642: edited under Spec); later turns are a fixed message or a simulated person with its description", () => {
  const html = editor();
  const turns = section(html, "turns");
  assert.match(visibleText(turns), /Turn 1 The message above\./);
  const spec = section(html, "spec");
  assert.match(spec, /Can you move me to an aisle seat\?/);
  for (const label of ["System prompt", "Message"])
    assert.match(visibleText(spec), new RegExp(label));
  for (const label of ["Tools", "Context"])
    assert.match(visibleText(section(html, "environment")), new RegExp(label));
  assert.match(turns, /data-turn-kind="message"[\s\S]*Is it free\?/);
  assert.match(
    turns,
    /data-turn-kind="person"[\s\S]*A traveler in a hurry who stops after one answer/,
  );
  assert.match(visibleText(turns), /Turn 2[\s\S]*Turn 3/);
  assert.match(visibleText(html), /runs 3 times and reports how many passed/);
});

test("RC-297 editor: tasks as removable chips with an Add a task picker", () => {
  const tasks = section(editor(), "tasks");
  assert.match(tasks, /Change a seat/);
  assert.match(tasks, /aria-label="Remove Change a seat"/);
  assert.match(tasks, /Add a task/);
});

test("RC-297 editor: every scorer with on/off, the task's limit as the hint, the eval's override, the expected tool and the criteria", () => {
  const checks = section(editor(), "checks");
  for (const kind of SCORER_KINDS) assert.match(checks, new RegExp(`data-check="${kind}"`));
  assert.match(checks, /placeholder="From the task: ≤ \$0.0177"/);
  assert.match(checks, /value="12.7"/, "The eval's run time override, in seconds.");
  assert.match(
    checks,
    /aria-label="Expected tool"[^>]*value="select_seat"|value="select_seat"[^>]*aria-label="Expected tool"/,
  );
  assert.match(checks, /Says the new seat/);
  assert.match(visibleText(checks), /Finishes cleanly No limit to set Built-in/);
  assert.match(
    visibleText(checks),
    /Cost per run Uses the task limit: ≤ \$0\.0177 Built-in/,
    "RC-657: the default shows in words, not only as a placeholder.",
  );
  assert.match(visibleText(checks), /Tool calls No limit from the task\. Built-in/);
});

test("RC-297 editor: fixed answers with tool, when, answer and why; Cancel, Save, and Save and run", () => {
  const html = editor();
  const fixed = section(html, "fixed-answers");
  assert.match(fixed, /data-fixed-answer="select_seat"/);
  assert.match(fixed, /value="\{&quot;seat&quot;:&quot;14C&quot;\}"/);
  assert.match(fixed, /&quot;charge&quot;: 0/);
  assert.match(fixed, /value="Seat changes are free on this fare"/);
  assert.match(visibleText(fixed), /Tool When .* Answer .* Why/);
  assert.match(visibleText(html), /A fixed answer wins over the recording/);
  assert.match(visibleText(html), /How tool answers are chosen/);
  assert.match(visibleText(html), /Cancel Save Save and run/);
  assert.match(html, new RegExp(`href="/project/${PROJECT_ID}/evals/e1/definition"[^>]*>Cancel`));
});

test('RC-297 editor: "Set a fixed answer for this tool" opens with that answer filled in', () => {
  const form = formFromEval({ ...ITEM, fixedAnswers: [] }, TASK_SCORERS);
  form.fixedAnswers.push(
    fixedAnswerFromStep({
      tool: "get_seat_map",
      args: '{\n  "flight": "MR214"\n}',
      result: '{\n  "aisle": ["14C", "17D"]\n}',
    }),
  );
  const html = editor({ initial: form, mockAt: 0 });
  assert.match(html, /data-fixed-answer="get_seat_map" data-prefilled="true"/);
  assert.match(html, /value="\{&quot;flight&quot;:&quot;MR214&quot;\}"/);
  assert.match(html, /&quot;aisle&quot;: \[&quot;14C&quot;, &quot;17D&quot;\]/);
});

test("RC-297, RC-657: Edit eval is the header's primary, not on the open editor nor twice on Definition", () => {
  const edit = `href="/project/${PROJECT_ID}/evals/e1?edit=1"`;
  assert.ok(
    render(
      createElement(EvalHeader, { projectId: PROJECT_ID, evalId: "e1", name: "x", runCount: 1 }),
    ).includes(edit),
  );
  assert.ok(
    !render(
      createElement(EvalHeader, {
        projectId: PROJECT_ID,
        evalId: "e1",
        name: "x",
        runCount: 1,
        editing: true,
      }),
    ).includes(edit),
  );
  const definition = render(
    createElement(EvalDefinition, {
      item: ITEM,
      tasks: TASKS,
      rules: evalRules([TASK_SCORERS], ITEM),
    }),
  );
  assert.ok(
    !definition.includes(edit),
    "RC-657: Edit is on the header only, one primary per screen.",
  );
  assert.match(decoded(definition), /Tool call find_booking → \{"seat":"22B"\}/);
  assert.match(decoded(definition), /Turn 3 Simulated person: A traveler in a hurry/);
  assert.match(
    decoded(definition),
    /select_seat when \{"seat":"14C"\} → \{"seat":"14C","charge":0\} · Seat changes are free on this fare/,
  );
});

test('RC-297, RC-648, RC-657: a tool step shows source "Fixed answer" with its reason in the replay\'s inspector', () => {
  const run: EvalRun = {
    id: "run1",
    projectId: PROJECT_ID,
    kind: "manual",
    fixId: null,
    suite: "Eval x",
    status: "completed",
    spend: { usd: 0, reservedUsd: 0, reserved: false },
    evalCount: 1,
    error: null,
    createdBy: "u",
    createdAt: AT,
    startedAt: AT,
    finishedAt: AT,
  };
  const result: EvalResult = {
    id: "r1",
    projectId: PROJECT_ID,
    runId: "run1",
    evalId: "e1",
    side: "before",
    passed: true,
    change: "new",
    error: null,
    createdAt: AT,
    verdicts: [],
    durationMs: 5_200,
    costUsd: 0.0071,
    toolCalls: 1,
    toolAnswers: [
      {
        tool: "select_seat",
        source: "mock",
        reason: "fixed_answer",
        ms: 330,
        why: "Seat changes are free on this fare",
      },
    ],
    transcript: {
      toolsOffered: ["select_seat"],
      steps: [
        { role: "assistant", text: "", calls: [{ name: "select_seat", args: { seat: "14C" } }] },
        { role: "tool", tool: "select_seat", content: '{"seat":"14C"}', isError: false },
        { role: "assistant", text: "Done.", calls: [] },
      ],
    },
  };
  const html = render(
    createElement(SingleTestView, {
      item: ITEM,
      tasks: TASKS,
      rules: [],
      run,
      result,
      replayHref: null,
    }),
    { search: "?peek=step:3" },
  );
  assert.match(html, /data-eval-run-replay/);
  assert.match(html, /data-answer-source="mock"/);
  assert.match(html, /Answer from <span[^>]*bg-info-subtle[^>]*>Fixed answer</);
  assert.match(visibleText(html), /Why: Seat changes are free on this fare/);
  assert.match(visibleText(html), /1 fixed answer/);
  // The step's details show when the person steps to it, with its reason.
  const [step] = testSteps(result).steps;
  assert.equal(
    step!.kind === "tool" ? step!.reason : null,
    "This eval fixes the answer of this tool for calls like this one. Why: Seat changes are free on this fare",
  );
});

const RUN_SETTINGS: RunSettingsModel = {
  level: "eval",
  own: { judgeModel: "claude-sonnet-5-5" },
  inherited: {
    agentModel: null,
    temperature: null,
    maxTokens: 4096,
    maxSteps: 8,
    budgetUsd: 1,
    toolModel: "claude-haiku-5-5",
    judgeModel: "claude-haiku-5-5",
  },
  models: ["claude-haiku-5-5", "claude-sonnet-5-5"],
  notEnabled: [],
};
const SWITCHES: EvalScorerSwitch[] = [
  {
    id: "s1",
    name: "No failed tool calls",
    scope: "task",
    enabled: true,
    on: true,
    overridden: false,
  },
  {
    id: "s2",
    name: "Under 6 tool calls",
    scope: "suite",
    enabled: true,
    on: false,
    overridden: true,
  },
];

test("RC-657 editor: Scenario, Environment, Expectations, Run settings, in that order, with one save bar", () => {
  const text = visibleText(editor({ runSettings: RUN_SETTINGS, scorers: SWITCHES }));
  const at = (word: string) => text.indexOf(word);
  assert.ok(
    at("Scenario") >= 0 &&
      at("Scenario") < at("Environment") &&
      at("Environment") < at("Expectations") &&
      at("Expectations") < at("Run settings"),
  );
  assert.equal(text.match(/Save and run/g)?.length, 1);
  assert.ok(!text.includes("Save run settings"), "The run settings save with the eval.");
});

test("RC-657 editor: run settings are collapsed with their values and sources in the row; a default shows as a value, not an empty field", () => {
  const html = editor({ runSettings: RUN_SETTINGS, scorers: SWITCHES });
  const text = visibleText(html);
  assert.match(
    text,
    /runs\. Agent model: recorded model \(suite default\) · Tool answer model: claude-haiku-5-5 \(suite default\) · Judge model: claude-sonnet-5-5 · Limits: suite default Change models and limits/,
  );
  assert.match(text, /Max tokens Suite default: 4096 Set own/);
  assert.match(html, /data-default-setting="maxSteps"/);
});

test("RC-657 editor: task and suite scorers are switches in the one Scorers list, after the built-in ones", () => {
  const checks = section(editor({ scorers: SWITCHES }), "checks");
  assert.match(
    visibleText(checks),
    /Task criteria .*Built-in No failed tool calls Task Under 6 tool calls Suite/,
  );
  assert.match(checks, /data-eval-scorer="s2"/);
});

test("RC-657 editor: tools and context are collapsed with their names in the row; a generated field has the one Generated mark", () => {
  const spec = {
    systemPrompt: "Help.",
    message: "Hi",
    tools: '[{"name": "find_booking"}, {"name": "select_seat"}]',
    context: '{"booking": "R1"}',
  };
  const html = editor({
    initial: { ...formFromEval(ITEM, TASK_SCORERS), spec },
    generated: ["tools"],
  });
  const text = visibleText(section(html, "environment"));
  assert.match(text, /Tools Generated 2 tools: find_booking, select_seat/);
  assert.match(text, /Context booking = R1/);
  assert.match(html, /data-generated-mark/);
  assert.ok(!/bg-warning-subtle[^>]*>Generated/.test(html), "Never the warning tone.");
});

test("RC-657 header: Edit eval is the one primary action; Remove is in the More actions menu", () => {
  const html = render(
    createElement(EvalHeader, { projectId: PROJECT_ID, evalId: "e1", name: "x", runCount: 1 }),
  );
  assert.match(html, /bg-accent[^"]*"[^>]*>Edit eval</);
  assert.match(html, /aria-label="More actions"/);
  assert.ok(!visibleText(html).includes("Remove"), "Remove is inside the closed menu.");
});
