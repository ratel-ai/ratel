import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixes } from "@/lib/views/fixes/build";
import { type MarkFixShippedDeps, markFixShipped } from "@/lib/views/fixes/mark-shipped";
import type { FixShipmentRow } from "@/lib/views/fixes/schema";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const model = buildFixes(fixesInput());
const fix = model.open[0]!;
const scope = { project: { id: PROJECT }, organization: { id: "org-1" } } as unknown as Awaited<
  ReturnType<MarkFixShippedDeps["findScope"]>
>;

function setup(over: Partial<MarkFixShippedDeps> = {}) {
  const events: { name: string; properties: Record<string, unknown> }[] = [];
  const links: { object: { kind: string; id: string }; source: { id: string } }[] = [];
  const created: Record<string, unknown>[] = [];
  const revalidated: string[] = [];
  const deps: MarkFixShippedDeps = {
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findScope: async () => scope,
    loadProjectFixes: async () => ({ ...model, projectId: PROJECT }),
    createFixShipment: async (input): Promise<FixShipmentRow> => {
      created.push(input as unknown as Record<string, unknown>);
      return {
        id: "ship-1",
        liveMarkedBy: null,
        ...input,
        shippedAt: new Date("2026-11-01T00:00:00Z"),
      };
    },
    recordLineage: async (input) => {
      links.push(input);
      return input.object;
    },
    trackServerEvent: (async (
      name: string,
      _context: unknown,
      properties: Record<string, unknown>,
    ) => {
      events.push({ name, properties });
    }) as MarkFixShippedDeps["trackServerEvent"],
    revalidate: (path) => revalidated.push(path),
    ...over,
  };
  return { deps, events, links, created, revalidated };
}

test("a project member records a shipment for an open fix", async () => {
  const { deps, events, links, created, revalidated } = setup();
  const result = await markFixShipped(
    { projectId: PROJECT, fixId: fix.id, version: " v2.0 ", notes: "Rolled out" },
    deps,
  );
  assert.deepEqual(result, { ok: true, version: "v2.0", shipmentId: "ship-1" });
  assert.equal(created[0]!.version, "v2.0");
  assert.equal(created[0]!.notes, "Rolled out");
  assert.equal(created[0]!.shippedBy, "user_1");
  assert.deepEqual(links.at(-1)!.object, {
    ...links.at(-1)!.object,
    kind: "shipment",
    id: "ship-1",
  });
  assert.equal(events[0]!.name, "fix_shipped");
  assert.equal(events[0]!.properties.surface, "fixes");
  assert.ok(revalidated.some((path) => path.endsWith("/improvement/fixes")));
  assert.ok(revalidated.some((path) => path.endsWith("/ship")));
});

test("empty notes are stored as null", async () => {
  const { deps, created } = setup();
  await markFixShipped({ projectId: PROJECT, fixId: fix.id, version: "v1", notes: "  " }, deps);
  assert.equal(created[0]!.notes, null);
});

test("someone who is not a member is refused and nothing is written", async () => {
  const { deps, events, created } = setup({ findScope: async () => null });
  const result = await markFixShipped({ projectId: PROJECT, fixId: fix.id, version: "v1" }, deps);
  assert.equal(result.ok, false);
  assert.equal(created.length, 0);
  assert.equal(events.length, 0);
});

test("no session is refused", async () => {
  const { deps, created } = setup({ getSession: async () => null });
  assert.equal(
    (await markFixShipped({ projectId: PROJECT, fixId: fix.id, version: "v1" }, deps)).ok,
    false,
  );
  assert.equal(created.length, 0);
});

test("a fix that is not in the project is refused", async () => {
  const { deps, created } = setup();
  const result = await markFixShipped(
    { projectId: PROJECT, fixId: "issue:nope", version: "v1" },
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal(created.length, 0);
});

test("an empty version, a version over 100 characters and notes over 1000 are refused", async () => {
  const { deps, created } = setup();
  for (const input of [
    { version: "   " },
    { version: "v".repeat(101) },
    { version: "v1", notes: "n".repeat(1001) },
  ]) {
    assert.equal(
      (await markFixShipped({ projectId: PROJECT, fixId: fix.id, ...input }, deps)).ok,
      false,
    );
  }
  assert.equal(created.length, 0);
});

test("a failed lineage link after the shipment is stored still reports the save, so a retry does not store it twice", async () => {
  const { deps, created, revalidated } = setup({
    recordLineage: async () => {
      throw new Error("lineage down");
    },
  });
  const result = await markFixShipped({ projectId: PROJECT, fixId: fix.id, version: "v1" }, deps);
  assert.deepEqual(result, { ok: true, version: "v1", shipmentId: "ship-1" });
  assert.equal(created.length, 1);
  assert.ok(revalidated.some((path) => path.endsWith("/improvement/fixes")));
  assert.ok(revalidated.some((path) => path.endsWith("/ship")));
});

test("a failed write is logged and reported as a retryable message", async () => {
  const { deps, events } = setup({
    createFixShipment: async () => {
      throw new Error("db down");
    },
  });
  const result = await markFixShipped({ projectId: PROJECT, fixId: fix.id, version: "v1" }, deps);
  assert.equal(result.ok, false);
  assert.equal(events.length, 0);
});
