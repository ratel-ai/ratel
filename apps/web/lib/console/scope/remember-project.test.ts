import assert from "node:assert/strict";
import { test } from "node:test";
import { LAST_PROJECT_COOKIE } from "@/lib/console/scope/cookie";
import {
  lastProjectDiffers,
  type RememberProjectDeps,
  rememberLastProject,
} from "@/lib/console/scope/remember-project";

const PROJECT_ID = "a7654cd9-a761-4bb1-8606-cb107e4c8d22";
const OTHER_ID = "b7654cd9-a761-4bb1-8606-cb107e4c8d22";

function harness(current: string | undefined, visible: readonly string[] = [PROJECT_ID]) {
  const written: { name: string; value: string; options: Record<string, unknown> }[] = [];
  const resolved: string[] = [];
  const deps: RememberProjectDeps = {
    current: async () => current,
    resolveProjectScope: async (projectId) => {
      resolved.push(projectId);
      return visible.includes(projectId) ? { projectId } : null;
    },
    write: (cookie) => {
      written.push(cookie);
    },
    secure: true,
  };
  return { deps, written, resolved };
}

test("opening a project writes the last-project cookie when none is set", async () => {
  const h = harness(undefined);
  assert.equal(await rememberLastProject(PROJECT_ID, h.deps), true);
  assert.deepEqual(
    h.written.map(({ name, value }) => [name, value]),
    [[LAST_PROJECT_COOKIE, PROJECT_ID]],
  );
  assert.deepEqual(h.written[0].options, {
    httpOnly: true,
    maxAge: 31_536_000,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
});

test("opening another project replaces the cookie", async () => {
  const h = harness(OTHER_ID);
  assert.equal(await rememberLastProject(PROJECT_ID, h.deps), true);
  assert.equal(h.written[0].value, PROJECT_ID);
});

test("the cookie is written only when it changes", async () => {
  const h = harness(PROJECT_ID.toUpperCase());
  assert.equal(await rememberLastProject(PROJECT_ID, h.deps), false);
  assert.deepEqual(h.written, []);
  assert.deepEqual(h.resolved, [], "nothing is read for a cookie that already matches");
});

test("a project outside the session organization is never remembered", async () => {
  const h = harness(undefined, []);
  assert.equal(await rememberLastProject(PROJECT_ID, h.deps), false);
  assert.deepEqual(h.written, []);
});

test("anything but a canonical project id is refused before any read", async () => {
  const h = harness(undefined);
  assert.equal(await rememberLastProject("../settings", h.deps), false);
  assert.deepEqual([h.written, h.resolved], [[], []]);
});

test("the shell asks for a write only when the cookie names another project or none", () => {
  assert.equal(lastProjectDiffers(undefined, PROJECT_ID), true);
  assert.equal(lastProjectDiffers(OTHER_ID, PROJECT_ID), true);
  assert.equal(lastProjectDiffers("not-a-uuid", PROJECT_ID), true);
  assert.equal(lastProjectDiffers(PROJECT_ID, PROJECT_ID), false);
  assert.equal(lastProjectDiffers(PROJECT_ID, "_"), false, "not a project id: nothing to remember");
});
