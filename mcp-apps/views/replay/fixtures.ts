import { errorResult, okResult, type ViewFixtures } from "../../shell/types";
import long from "./captured/long.json";
import redacted from "./captured/redacted.json";
import short from "./captured/short.json";
import stepContent from "./captured/step-content.json";

/**
 * Captured from the local demo (pnpm mcp-apps:local, project mcp-apps-local):
 * each tool's `view` as the server sends it, with the project id replaced.
 * "short" is the session replay demo session, "long" an OpenTelemetry demo
 * session of six turns, "redacted" the short session with content reading off.
 */

/** One run of the long session, its third turn: the same session, with the run's own turn named. */
export const run = { view: { ...long.view, turnIndex: 3 } };

const data = {
  sessionId: "replay-demo-session",
  href: "/project/5d2a7c1e-4b8f-4e2a-9c3d-6f1e0a9b8c7d/sessions/replay-demo-session",
};
const content = { get_session_step_content: okResult(stepContent) };
const offContent = { get_session_step_content: okResult({ contentOptIn: false, content: null }) };

const fixtures: ViewFixtures = {
  "short session": {
    tool: "get_session",
    input: { sessionId: "replay-demo-session" },
    result: okResult(data, short),
    calls: content,
  },
  "long session": {
    tool: "get_session",
    input: { sessionId: "hd-s124" },
    result: okResult({ ...data, sessionId: "hd-s124" }, long),
    calls: content,
  },
  "session redacted": {
    tool: "get_session",
    input: { sessionId: "replay-demo-session" },
    result: okResult(data, redacted),
    calls: offContent,
  },
  run: {
    tool: "get_run_summary",
    input: { traceId: "a296ac386655a8abe7707b353edce962" },
    result: okResult({ traceId: "a296ac386655a8abe7707b353edce962" }, run),
    calls: content,
  },
  conversation: {
    tool: "get_trace_conversation",
    input: { traceId: "a296ac386655a8abe7707b353edce962" },
    result: okResult({ traceId: "a296ac386655a8abe7707b353edce962" }, run),
    calls: content,
  },
  "run outside a session": {
    tool: "get_run_summary",
    input: { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" },
    result: okResult({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736" }),
  },
  "replay off": {
    tool: "get_session",
    input: { sessionId: "replay-demo-session" },
    result: errorResult("forbidden", "Session replay is not enabled for this organization."),
  },
};

export default fixtures;
