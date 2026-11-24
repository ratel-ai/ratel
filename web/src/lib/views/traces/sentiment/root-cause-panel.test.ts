import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRootCauseQuery,
  rootCausesHref,
  withoutRootCauses,
} from "@/lib/views/traces/sentiment/page-paths";

test("root causes open in a panel of Agent health, on its window, narrowed as asked", () => {
  assert.equal(
    rootCausesHref("p1", { days: 30, filters: { task: "not_completed", reason: "failed_call" } }),
    "/project/p1/health?days=30&rc=1&rc_task=not_completed&rc_why=failed_call",
  );
});

test("opened over another page they keep that page's own address", () => {
  const host = { path: "/project/p1/traces/sentiment", query: "days=90&intent=i-1" };
  const href = rootCausesHref("p1", { days: 90, filters: { task: "not_completed" }, host });
  assert.equal(href, "/project/p1/traces/sentiment?days=90&intent=i-1&rc=1&rc_task=not_completed");
  assert.equal(withoutRootCauses(href.split("?")[1]!), "days=90&intent=i-1");
});

test("the panel's state is read back from its own parameters only", () => {
  const query = parseRootCauseQuery({
    rc: "1",
    rc_task: "not_completed",
    rc_sort: "cost",
    cause: "tool_fault",
  });
  assert.equal(query?.filters.task, "not_completed");
  assert.equal(query?.filters.cause, null, "the host page's filter is not the panel's");
  assert.equal(query?.sort, "cost");
  assert.equal(parseRootCauseQuery({ task: "not_completed" }), null);
});

test("closing the panel lets go of the turn opened in it", () => {
  assert.equal(withoutRootCauses("days=7&rc=1&rc_open=k&turn=t&call=c"), "days=7");
});
