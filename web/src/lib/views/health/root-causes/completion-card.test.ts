import assert from "node:assert/strict";
import { test } from "node:test";
import { taskCompletionCard } from "@/lib/views/health/root-causes/completion-card";

test("task completion: shares of the tasks that can be told, and the two that need explaining open Root cause analysis", () => {
  const card = taskCompletionCard("p1", 7, [
    { result: "completed", tasks: 6 },
    { result: "completed_after_friction", tasks: 2 },
    { result: "not_completed", tasks: 2 },
    { result: "unknown", tasks: 5 },
  ]);
  assert.equal(card.total, 10, "a task that can't be told is left out");
  assert.deepEqual(
    card.statuses.map((status) => [status.filter, status.tasks, status.share, status.href]),
    [
      ["completed", 6, 0.6, null],
      [
        "completed_after_friction",
        2,
        0.2,
        "/project/p1/health?days=7&rc=1&rc_task=completed_after_friction",
      ],
      ["not_completed", 2, 0.2, "/project/p1/health?days=7&rc=1&rc_task=not_completed"],
    ],
  );
  assert.equal(card.href, "/project/p1/health?days=7&rc=1");
});

test("a status with no tasks opens nothing, and no tasks is an empty card", () => {
  const card = taskCompletionCard("p1", 30, [{ result: "completed", tasks: 3 }]);
  assert.deepEqual(
    card.statuses.map((status) => status.href),
    [null, null, null],
  );
  assert.equal(taskCompletionCard("p1", 30, []).total, 0);
});
