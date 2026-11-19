import assert from "node:assert/strict";
import { test } from "node:test";
import { storedLastProject } from "@/lib/console/scope/landing";

/** The stored last-project pointer the landing falls back to (owned `landing.ts`). */

const PROJECT_ID = "a7654cd9-a761-4bb1-8606-cb107e4c8d22";
const DB_PROJECT_ID = "b7654cd9-a761-4bb1-8606-cb107e4c8d22";
const USER_ID = "11111111-1111-4111-8111-111111111111";

test("with an edition that remembers the last project, its pointer is the fallback (upstream's users.last_project_id)", async () => {
  let fellBack = false;
  const read = storedLastProject({ lastProject: async () => DB_PROJECT_ID }, async () => {
    fellBack = true;
    return PROJECT_ID;
  });
  assert.equal(await read(USER_ID), DB_PROJECT_ID);
  assert.equal(fellBack, false, "the first project is not read when the edition keeps a pointer");
});

test("an edition with no pointer yet lands nowhere, as upstream, rather than on the first project", async () => {
  const read = storedLastProject({ lastProject: async () => null }, async () => PROJECT_ID);
  assert.equal(await read(USER_ID), null);
});

test("without an edition pointer, the fallback is the active organization's first project", async () => {
  const read = storedLastProject({}, async () => PROJECT_ID);
  assert.equal(await read(USER_ID), PROJECT_ID);
});
