import {
  alertDetail,
  alerts,
  fixDetail,
  fixes,
  intentDetail,
  intents,
  projectOverview,
  projects,
  scorerDetail,
  scorers,
  sdkEventDetail,
  sdkEvents,
  skillDetail,
  skills,
  taskDetail,
  tasks,
} from "../../harness/data";
import { okResult, type ViewFixtures } from "../../shell/types";

const [first] = intents(8);
const busiest = intents(30, 17)[0];
const quiet = { ...intents(1, 5)[0], tasks: [], tools: [], selfCorrections: 0, askedAgain: 0 };
const [failing] = tasks(8, 23).filter((task) => task.status !== "healthy");
const healthy = { ...tasks(1, 2)[0], status: "healthy" as const, issues: 0, fixes: 0 };
const [fix] = fixes(4);
const [skill] = skills(3);
const [search] = sdkEvents(3);
const [project] = projects(2);
const windowed = {
  window: { since: "2026-10-12T14:00:00.000Z", until: "2026-11-11T14:00:00.000Z" },
};

/** Each bound tool has `<tool>`, `<tool> · dense` and `<tool> · empty` (views/bindings.test.ts checks). */
const fixtures: ViewFixtures = {
  get_intent: { tool: "get_intent", result: okResult(intentDetail(first)) },
  "get_intent · dense": { tool: "get_intent", result: okResult(intentDetail(busiest)) },
  "get_intent · empty": {
    tool: "get_intent",
    result: okResult({ ...intentDetail(quiet), exampleAsks: [] }),
  },
  "get_intent · redacted": { tool: "get_intent", result: okResult(intentDetail(first, true)) },
  get_task: { tool: "get_task", result: okResult(taskDetail(failing)) },
  "get_task · dense": {
    tool: "get_task",
    result: okResult(taskDetail({ ...failing, issues: 6, fixes: 6 }, 8, 29, true)),
  },
  "get_task · empty": { tool: "get_task", result: okResult(taskDetail(healthy, 0)) },
  get_fix: { tool: "get_fix", result: okResult(fixDetail(fix)) },
  "get_fix · dense": {
    tool: "get_fix",
    result: okResult(fixDetail({ ...fix, status: "applied" })),
  },
  "get_fix · empty": {
    tool: "get_fix",
    result: okResult(fixDetail({ ...fix, effect: null }, false)),
  },
  get_skill: { tool: "get_skill", result: okResult(skillDetail(skill)) },
  "get_skill · dense": {
    tool: "get_skill",
    result: okResult(
      skillDetail({
        ...skill,
        model: "claude-sonnet-5-5",
        searchableDescription: "Refunds, chargebacks, duplicate payments",
      }),
    ),
  },
  "get_skill · empty": {
    tool: "get_skill",
    result: okResult(skillDetail({ ...skills(4)[3] }, true)),
  },
  get_sdk_event: { tool: "get_sdk_event", result: okResult(sdkEventDetail(search)) },
  "get_sdk_event · dense": {
    tool: "get_sdk_event",
    result: okResult(sdkEventDetail({ ...search, error: "timeout after 2 s" })),
  },
  "get_sdk_event · empty": {
    tool: "get_sdk_event",
    result: okResult(sdkEventDetail({ ...sdkEvents(3)[2], durationMs: null })),
  },
  "get_sdk_event · redacted": {
    tool: "get_sdk_event",
    result: okResult(sdkEventDetail(search, true)),
  },
  get_project_overview: {
    tool: "get_project_overview",
    result: okResult(projectOverview(project), windowed),
  },
  "get_project_overview · dense": {
    tool: "get_project_overview",
    result: okResult(projectOverview(projects(2)[1]), windowed),
  },
  "get_project_overview · empty": {
    tool: "get_project_overview",
    result: okResult(projectOverview(project, false), windowed),
  },
  get_scorer: { tool: "get_scorer", result: okResult(scorerDetail(scorers(2)[0])) },
  "get_scorer · dense": {
    tool: "get_scorer",
    result: okResult(scorerDetail(scorers(2)[1], 25)),
  },
  "get_scorer · empty": {
    tool: "get_scorer",
    result: okResult(scorerDetail({ ...scorers(1)[0], result: "" }, 0)),
  },
  get_alert: { tool: "get_alert", result: okResult(alertDetail(alerts(1)[0])) },
  "get_alert · dense": { tool: "get_alert", result: okResult(alertDetail(alerts(2)[0], 25)) },
  "get_alert · empty": { tool: "get_alert", result: okResult(alertDetail(alerts(3)[2], 0)) },
};

export default fixtures;
