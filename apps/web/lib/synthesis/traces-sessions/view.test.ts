import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSessionsFilter,
  SESSION_ID_ATTRIBUTE,
  SESSION_ID_PROMPT,
  sessionsEmptyKind,
  withSessionsFilter,
} from "./view";

/** RC-313: the Sessions tab's filter lives in the URL. */

test("the filter reads from ?show=: All or Failed, no To check", () => {
  assert.equal(parseSessionsFilter("failed"), "failed");
  assert.equal(parseSessionsFilter("to_check"), "all");
  assert.equal(
    parseSessionsFilter(["failed", "all"]),
    "failed",
    "a repeated value reads as its first",
  );
  assert.equal(parseSessionsFilter(null), "all");
  assert.equal(parseSessionsFilter([]), "all");
});

test("changing the filter drops the open row and keeps the rest, the timeframe too", () => {
  assert.equal(
    withSessionsFilter("?window=24h&peek=session:x&columns=tools", "failed"),
    "?window=24h&columns=tools&show=failed",
  );
  assert.equal(withSessionsFilter("?show=failed", "all"), "");
});

// RC-752: an empty Sessions list says why, and points at what to do next.

test("turns but no sessions is its own empty kind, not 'No turns yet'", () => {
  assert.equal(
    sessionsEmptyKind({ filter: "all", filtered: false, hasEvents: true, hasSpans: true }),
    "no-sessions",
  );
  assert.equal(
    sessionsEmptyKind({ filter: "all", filtered: false, hasEvents: false, hasSpans: true }),
    "no-sessions",
    "spans alone are turns too",
  );
});

test("no telemetry at all keeps the send-your-first-trace kind; events without spans keep events-only", () => {
  assert.equal(
    sessionsEmptyKind({ filter: "all", filtered: false, hasEvents: false, hasSpans: false }),
    "no-telemetry",
  );
  assert.equal(
    sessionsEmptyKind({ filter: "all", filtered: false, hasEvents: true, hasSpans: false }),
    "events-only",
  );
});

test("property filters and the Failed filter win over the telemetry check", () => {
  assert.equal(
    sessionsEmptyKind({ filter: "failed", filtered: true, hasEvents: true, hasSpans: true }),
    "filtered",
  );
  assert.equal(
    sessionsEmptyKind({ filter: "failed", filtered: false, hasEvents: true, hasSpans: true }),
    "no-failed",
  );
});

test("the session guidance names gen_ai.conversation.id, and the agent prompt tells an agent to set it on every span of one conversation", () => {
  assert.equal(SESSION_ID_ATTRIBUTE, "gen_ai.conversation.id");
  assert.match(SESSION_ID_PROMPT, /gen_ai\.conversation\.id/);
  assert.match(SESSION_ID_PROMPT, /every span/);
  assert.match(SESSION_ID_PROMPT, /one conversation/);
});
