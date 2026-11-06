import assert from "node:assert/strict";
import { test } from "node:test";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";

test("top-level task links encode ids and preserve redirect query values", () => {
  assert.equal(topLevelTasksHref("p /1"), "/project/p%20%2F1/tasks");
  assert.equal(
    topLevelTasksHref("p1", "wf/a", { peek: "step:notify", tag: ["a", "b"], empty: undefined }),
    "/project/p1/tasks/wf%2Fa?peek=step%3Anotify&tag=a&tag=b",
  );
  assert.equal(
    topLevelTasksHref("p1", undefined, { peek: "unserved" }),
    "/project/p1/tasks?peek=unserved",
  );
});
