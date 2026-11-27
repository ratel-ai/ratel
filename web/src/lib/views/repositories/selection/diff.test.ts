import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnifiedDiff } from "./diff";
import { fixture } from "./test-support";

test("each file of a diff, with its added and removed lines", () => {
  const files = parseUnifiedDiff(fixture("refund-tool.diff"));
  assert.deepEqual(
    files.map((file) => [file.path, file.status, file.added.length, file.removed.length]),
    [
      ["README.md", "modified", 1, 0],
      ["src/tools/refund_order.ts", "modified", 2, 1],
      ["src/tools/refund_order.test.ts", "modified", 3, 0],
    ],
  );
  assert.deepEqual(files[1].removed, ['    if (!order) throw new Error("no such order");']);
  assert.equal(
    files[1].added[1],
    '    if (order.refundedAt) return { status: "already_refunded", orderId };',
  );
});

test("renames, deletions, binary files and renames with no hunk", () => {
  const files = parseUnifiedDiff(fixture("shapes.diff"));
  assert.deepEqual(
    files.map(({ path, oldPath, status, binary }) => ({ path, oldPath, status, binary })),
    [
      { path: "src/new_name.ts", oldPath: "src/old_name.ts", status: "renamed", binary: false },
      { path: "src/gone.ts", oldPath: "src/gone.ts", status: "deleted", binary: false },
      { path: "assets/logo.png", oldPath: null, status: "added", binary: true },
      { path: "src/also_moved.ts", oldPath: "src/moved.ts", status: "renamed", binary: false },
    ],
  );
  assert.deepEqual(files[1].removed, ["export const gone = true;"]);
});

test("an empty diff has no files", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
});
