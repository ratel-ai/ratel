import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAYLOAD_READ_FAILED,
  readSdkEventPayload,
  type SdkEventPayloadDeps,
} from "@/lib/console/settings/sdk-event-payload";
import type { RuntimeEventRow } from "@/lib/ingest/runtime-events/queries";

// Only the fields a payload read uses; the rest of the row is irrelevant here.
const EVENT = {
  id: "00000000-0000-8000-8000-000000000001",
  eventId: "evt-1",
  payload: { error: "502" },
} as unknown as RuntimeEventRow;

function deps(
  overrides: Partial<SdkEventPayloadDeps> = {},
): SdkEventPayloadDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    isDbConfigured: () => true,
    getUserId: async () => "u1",
    findProject: async (projectId, userId) =>
      projectId === "p1" && userId === "u1" ? { id: "p1" } : null,
    readEvent: async (projectId, identifier) => {
      reads.push(`${projectId}/${identifier}`);
      return identifier === "evt-1" ? EVENT : null;
    },
    ...overrides,
  };
}

test("an open event's payload comes back whole, read in the reader's own project", async () => {
  const d = deps();
  assert.deepEqual(await readSdkEventPayload({ projectId: "p1", identifier: "evt-1" }, d), {
    ok: true,
    payload: { identifier: "evt-1", json: JSON.stringify({ error: "502" }, null, 2) },
  });
  assert.deepEqual(d.reads, ["p1/evt-1"]);
});

test("nothing is read for someone outside the project or without a session", async () => {
  const outsider = deps();
  assert.deepEqual(await readSdkEventPayload({ projectId: "p2", identifier: "evt-1" }, outsider), {
    ok: false,
    error: "Project not found.",
  });
  assert.deepEqual(outsider.reads, []);
  assert.deepEqual(
    await readSdkEventPayload(
      { projectId: "p1", identifier: "evt-1" },
      deps({ getUserId: async () => null }),
    ),
    { ok: false, error: "Your session has expired. Sign in again." },
  );
});

test("bad input is refused before any read", async () => {
  const d = deps();
  for (const input of [
    { projectId: "p1", identifier: "" },
    { projectId: "", identifier: "evt-1" },
    { projectId: "p1", identifier: 42 },
    { projectId: "p1", identifier: "x".repeat(513) },
  ]) {
    assert.deepEqual(await readSdkEventPayload(input, d), {
      ok: false,
      error: "That event can't be found.",
    });
  }
  assert.deepEqual(d.reads, []);
});

test("a missing event and a failed read say different things", async () => {
  assert.deepEqual(await readSdkEventPayload({ projectId: "p1", identifier: "evt-gone" }, deps()), {
    ok: false,
    error: "This event is no longer stored.",
  });
  assert.deepEqual(
    await readSdkEventPayload(
      { projectId: "p1", identifier: "evt-1" },
      deps({ readEvent: async () => PAYLOAD_READ_FAILED }),
    ),
    { ok: false, error: "Couldn't load the payload. Try again in a moment." },
  );
});
