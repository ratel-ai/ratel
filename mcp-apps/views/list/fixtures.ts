import {
  declaredTools,
  declaredToolsResult,
  fixDetail,
  fixes,
  fixesResult,
  insightRowsView,
  insights,
  intentDetail,
  intents,
  invokedTools,
  logs,
  projectOverview,
  projects,
  sdkEventDetail,
  sdkEvents,
  sdkEventsResult,
  shipments,
  skillDetail,
  skills,
  spanGroups,
  taskDetail,
  tasks,
  tasksResult,
  traceDetail,
  traces,
} from "../../harness/data";
import { okResult, type ViewFixture, type ViewFixtures } from "../../shell/types";

/**
 * Each bound tool has `<tool>` (a page, its first row's detail and, where the
 * tool pages, the next page), `<tool> · dense` and `<tool> · empty`
 * (views/bindings.test.ts checks). Shapes follow lib/mcp/operations.
 */
const projectId = "6f1c2a40-8b7e-4c1d-9a51-3e2b7d0c9f11";
const input = { projectId };
const cut = { truncated: true };
const windowed = {
  window: { since: "2026-10-12T14:00:00.000Z", until: "2026-11-11T14:00:00.000Z" },
};

function scenarios(
  tool: string,
  normal: ViewFixture,
  dense: ViewFixture,
  empty: ViewFixture,
): ViewFixtures {
  return { [tool]: normal, [`${tool} · dense`]: dense, [`${tool} · empty`]: empty };
}

const someTraces = traces(12);
const someIntents = intents(8);
const someTasks = tasks(8);
/** The row the list shows first (busiest), so the Panel's title and body agree. */
const busiestTask = [...someTasks].sort((a, b) => b.runs - a.runs)[0];
const denseTasks = tasks(25, 5);
const someFixes = fixes(9);
const someSkills = skills(10);
const someEvents = sdkEvents(14);
const someProjects = projects(4);

const fixtures: ViewFixtures = {
  ...scenarios(
    "list_traces",
    {
      tool: "list_traces",
      input: { since: "2026-11-10T14:00:00Z" },
      result: okResult(
        { count: someTraces.length, hasMore: true, nextCursor: "c2", traces: someTraces },
        cut,
      ),
      calls: {
        get_trace: okResult(traceDetail(someTraces[0].traceId)),
        list_traces: okResult({
          count: 6,
          hasMore: false,
          nextCursor: null,
          traces: traces(6, 99),
        }),
      },
    },
    {
      tool: "list_traces",
      result: okResult({ count: 50, hasMore: false, nextCursor: null, traces: traces(50, 21) }),
      calls: { get_trace: okResult(traceDetail("dense")) },
    },
    {
      tool: "list_traces",
      result: okResult({ count: 0, hasMore: false, nextCursor: null, traces: [] }),
    },
  ),
  ...scenarios(
    "list_intents",
    {
      tool: "list_intents",
      input,
      result: okResult({
        status: "ready",
        computedAt: "2026-11-11T09:00:00Z",
        windowDays: 30,
        capped: false,
        intents: someIntents,
      }),
      calls: { get_intent: okResult(intentDetail(someIntents[0])) },
    },
    {
      tool: "list_intents",
      input,
      result: okResult({
        status: "ready",
        computedAt: "2026-11-11T09:00:00Z",
        windowDays: 30,
        capped: true,
        intents: intents(30, 17),
      }),
    },
    {
      tool: "list_intents",
      input,
      result: okResult({
        status: "ready",
        computedAt: "2026-11-11T09:00:00Z",
        windowDays: 30,
        capped: false,
        intents: [],
      }),
    },
  ),
  "list_intents · redacted": {
    tool: "list_intents",
    input,
    result: okResult({
      status: "ready",
      computedAt: "2026-11-11T09:00:00Z",
      windowDays: 30,
      capped: false,
      intents: someIntents,
    }),
    calls: { get_intent: okResult(intentDetail(someIntents[0], true)) },
  },
  ...scenarios(
    "list_tasks",
    {
      tool: "list_tasks",
      input,
      result: okResult(tasksResult(someTasks)),
      calls: { get_task: okResult(taskDetail(busiestTask)) },
    },
    {
      tool: "list_tasks",
      input,
      result: okResult(tasksResult(denseTasks), cut),
      calls: {
        get_task: okResult(taskDetail([...denseTasks].sort((a, b) => b.runs - a.runs)[0], 8)),
      },
    },
    { tool: "list_tasks", input, result: okResult(tasksResult([])) },
  ),
  ...scenarios(
    "list_fixes",
    {
      tool: "list_fixes",
      input,
      result: okResult(fixesResult(someFixes)),
      calls: { get_fix: okResult(fixDetail(someFixes[0])) },
    },
    {
      tool: "list_fixes",
      input,
      result: okResult(fixesResult(fixes(40, 3)), cut),
      calls: { get_fix: okResult(fixDetail(fixes(40, 3)[0])) },
    },
    { tool: "list_fixes", input, result: okResult(fixesResult([])) },
  ),
  ...scenarios(
    "list_insights",
    // The view model carries Agent health's rows: one per kind of issue, though the tool returns every issue.
    {
      tool: "list_insights",
      input,
      result: okResult({ count: 7, insights: insights(7) }, { view: insightRowsView(insights(7)) }),
    },
    {
      tool: "list_insights",
      input,
      result: okResult(
        { count: 30, insights: insights(30, 9) },
        { ...cut, view: insightRowsView(insights(30, 9)) },
      ),
    },
    {
      tool: "list_insights",
      input,
      result: okResult({ count: 0, insights: [] }, { view: insightRowsView([]) }),
    },
  ),
  // A host that passes no view model: the list is the tool's own rows, one per issue.
  "list_insights · no view model": {
    tool: "list_insights",
    input,
    result: okResult({ count: 7, insights: insights(7) }),
  },
  // The call asked for the slowest runs: the rows stay in the tool's order and Duration reads as sorted.
  "list_traces · sorted by duration": {
    tool: "list_traces",
    input: { since: "2026-11-10T14:00:00Z", sort: "duration" },
    result: okResult({
      count: someTraces.length,
      hasMore: false,
      nextCursor: null,
      traces: [...someTraces].sort((a, b) => b.durationMs - a.durationMs),
    }),
    calls: { get_trace: okResult(traceDetail(someTraces[0].traceId)) },
  },
  ...scenarios(
    "list_skills",
    {
      tool: "list_skills",
      input,
      result: okResult({ count: someSkills.length, offset: 0, skills: someSkills }),
      calls: { get_skill: okResult(skillDetail(someSkills[0])) },
    },
    {
      tool: "list_skills",
      input,
      result: okResult({ count: 50, offset: 0, skills: skills(50, 2) }, cut),
      calls: { get_skill: okResult(skillDetail(skills(50, 2)[0])) },
    },
    { tool: "list_skills", input, result: okResult({ count: 0, offset: 0, skills: [] }) },
  ),
  ...scenarios(
    "list_shipments",
    { tool: "list_shipments", input, result: okResult({ count: 6, shipments: shipments(6) }) },
    {
      tool: "list_shipments",
      input,
      result: okResult({ count: 40, shipments: shipments(25, 8) }, cut),
    },
    { tool: "list_shipments", input, result: okResult({ count: 0, shipments: [] }) },
  ),
  ...scenarios(
    "list_sdk_events",
    {
      tool: "list_sdk_events",
      input,
      result: okResult(sdkEventsResult(someEvents), windowed),
      calls: { get_sdk_event: okResult(sdkEventDetail(someEvents[0])) },
    },
    {
      tool: "list_sdk_events",
      input,
      result: okResult(sdkEventsResult(sdkEvents(60, 4)), { ...windowed, ...cut }),
      calls: { get_sdk_event: okResult(sdkEventDetail(sdkEvents(60, 4)[0])) },
    },
    { tool: "list_sdk_events", input, result: okResult(sdkEventsResult([]), windowed) },
  ),
  "list_sdk_events · redacted": {
    tool: "list_sdk_events",
    input,
    result: okResult(sdkEventsResult(sdkEvents(14, 47, true), true), windowed),
    calls: { get_sdk_event: okResult(sdkEventDetail(sdkEvents(14, 47, true)[0], true)) },
  },
  ...scenarios(
    "list_logs",
    {
      tool: "list_logs",
      input,
      result: okResult({ count: 20, hasMore: true, nextCursor: "l2", logs: logs(20) }, windowed),
      calls: {
        list_logs: okResult(
          { count: 8, hasMore: false, nextCursor: null, logs: logs(8, 77) },
          windowed,
        ),
      },
    },
    {
      tool: "list_logs",
      input,
      result: okResult(
        { count: 50, hasMore: false, nextCursor: null, logs: logs(50, 3) },
        windowed,
      ),
    },
    {
      tool: "list_logs",
      input,
      result: okResult({ count: 0, hasMore: false, nextCursor: null, logs: [] }, windowed),
    },
  ),
  ...scenarios(
    "list_projects",
    {
      tool: "list_projects",
      result: okResult({ count: someProjects.length, projects: someProjects }),
      calls: { get_project_overview: okResult(projectOverview(someProjects[0]), windowed) },
    },
    {
      tool: "list_projects",
      result: okResult({ count: 24, projects: projects(24, 6) }),
      calls: {
        get_project_overview: okResult(projectOverview(projects(24, 6)[0], false), windowed),
      },
    },
    { tool: "list_projects", result: okResult({ count: 0, projects: [] }) },
  ),
  ...scenarios(
    "list_span_groups",
    {
      tool: "list_span_groups",
      input: { ...input, groupBy: "name" },
      result: okResult(
        { source: "otel_spans", groupBy: "name", count: 8, total: 8, operations: spanGroups(8) },
        windowed,
      ),
    },
    {
      tool: "list_span_groups",
      input: { ...input, groupBy: "name" },
      result: okResult(
        {
          source: "otel_spans",
          groupBy: "name",
          count: 50,
          total: 64,
          operations: spanGroups(50, 2),
        },
        { ...windowed, ...cut },
      ),
    },
    {
      tool: "list_span_groups",
      input,
      result: okResult(
        { source: "otel_spans", groupBy: "name", count: 0, total: 0, operations: [] },
        windowed,
      ),
    },
  ),
  ...scenarios(
    "list_invoked_tools",
    {
      tool: "list_invoked_tools",
      input,
      result: okResult({ count: 8, total: 8, tools: invokedTools(8) }),
    },
    {
      tool: "list_invoked_tools",
      input,
      result: okResult({ count: 40, total: 52, tools: invokedTools(40, 3) }, cut),
    },
    { tool: "list_invoked_tools", input, result: okResult({ count: 0, total: 0, tools: [] }) },
  ),
  ...scenarios(
    "list_declared_tools",
    {
      tool: "list_declared_tools",
      input,
      result: okResult(declaredToolsResult(declaredTools(10))),
    },
    {
      tool: "list_declared_tools",
      input,
      result: okResult(declaredToolsResult(declaredTools(40, 5)), cut),
    },
    { tool: "list_declared_tools", input, result: okResult(declaredToolsResult([])) },
  ),
};

export default fixtures;
