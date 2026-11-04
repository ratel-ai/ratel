import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LAST_PROJECT_COOKIE,
  lastProjectCookie,
  parseLastProjectCookie,
  parseProjectUuid,
  projectIdFromScopedPath,
} from "@/lib/console/scope/cookie";

test("project UUID parser accepts only canonical UUIDs", () => {
  const projectId = "A7654CD9-A761-4BB1-8606-CB107E4C8D22";

  assert.deepEqual(
    [parseProjectUuid(projectId), parseProjectUuid("../settings")],
    [projectId.toLowerCase(), null],
  );
});

test("last-project cookie accepts only canonical project UUIDs", () => {
  const projectId = "a7654cd9-a761-4bb1-8606-cb107e4c8d22";

  assert.deepEqual(
    [parseLastProjectCookie(projectId), parseLastProjectCookie("../settings")],
    [projectId, null],
  );
});

test("last-project cookie is durable, server-only, and site-scoped", () => {
  const projectId = "a7654cd9-a761-4bb1-8606-cb107e4c8d22";

  assert.deepEqual(lastProjectCookie(projectId, true), {
    name: LAST_PROJECT_COOKIE,
    value: projectId,
    options: {
      httpOnly: true,
      maxAge: 31_536_000,
      path: "/",
      sameSite: "lax",
      secure: true,
    },
  });
});

test("scoped project paths expose a valid UUID but never the sentinel", () => {
  const projectId = "a7654cd9-a761-4bb1-8606-cb107e4c8d22";

  assert.deepEqual(
    [
      projectIdFromScopedPath(`/project/${projectId}/traces`),
      projectIdFromScopedPath("/project/_/traces"),
      projectIdFromScopedPath("/project/not-a-uuid"),
    ],
    [projectId, null, null],
  );
});
