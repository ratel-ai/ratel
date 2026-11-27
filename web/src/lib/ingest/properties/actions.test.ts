import assert from "node:assert/strict";
import { test } from "node:test";
import { ossEntitlements } from "@/lib/adapters/oss/entitlements";
import { changeTraceProperty, MAX_USER_INDEXED, type TracePropertyActionDeps } from "./actions";
import type { TraceProperty } from "./store";

function property(name: string, over: Partial<TraceProperty> = {}): TraceProperty {
  return {
    name,
    state: "detected",
    source: "user",
    column: null,
    firstSeenAt: new Date(0),
    lastSeenAt: new Date(0),
    seenCount: 1,
    indexedAt: null,
    ...over,
  };
}

function setup(over: Partial<TracePropertyActionDeps> = {}, indexedOwn = 0) {
  const calls: unknown[][] = [];
  const store = new Map<string, TraceProperty>([
    ["app.plan", property("app.plan")],
    ["organization", property("organization", { state: "indexed", source: "standard" })],
    ["user", property("user", { state: "indexed", source: "standard", column: "end_user_id" })],
    ["app.old", property("app.old")],
  ]);
  const deps: TracePropertyActionDeps = {
    findProjectScope: async (id) => ({ project: { id }, organization: { id: "o" }, role: "admin" }),
    enabled: async () => true,
    isRestricted: async () => false,
    indexLimit: () => Number.POSITIVE_INFINITY,
    find: async (_projectId, name) => store.get(name) ?? null,
    countUserIndexed: async () => indexedOwn,
    setState: async (projectId, name, state) => {
      calls.push(["setState", projectId, name, state]);
      const before = store.get(name)!;
      // As the store does: indexing sets indexedAt, stopping keeps it.
      const next = {
        ...before,
        state,
        indexedAt: state === "indexed" ? new Date(1) : before.indexedAt,
      };
      store.set(name, next);
      return next;
    },
    erase: async (projectId, name) => {
      calls.push(["erase", projectId, name]);
      return { spans: 3, traces: 1 };
    },
    fill: async (projectId, names) => {
      calls.push(["fill", projectId, names]);
    },
    observe: async () => {},
    ...over,
  };
  return { deps, calls };
}

test("a person indexes a detected key when the entitlement allows it, and the fill starts", async () => {
  const { deps, calls } = setup();
  const result = await changeTraceProperty("p", { action: "index", name: "app.plan" }, deps);
  assert.ok(result.ok);
  assert.equal(result.property.state, "indexed");
  assert.deepEqual(calls, [
    ["setState", "p", "app.plan", "indexed"],
    ["fill", "p", ["app.plan"]],
  ]);
});

test("the open-source edition allows it", async () => {
  const limit = ossEntitlements.getLimits({ id: "o" }).maxIndexedPropertiesPerProject;
  const { deps } = setup({ indexLimit: () => limit ?? 0 }, MAX_USER_INDEXED - 1);
  assert.equal(
    (await changeTraceProperty("p", { action: "index", name: "app.plan" }, deps)).ok,
    true,
  );
});

test("without the entitlement, indexing is refused with a message that names the limit and the paid plan", async () => {
  for (const indexLimit of [() => 0, () => undefined as unknown as number]) {
    const { deps, calls } = setup({ indexLimit });
    const result = await changeTraceProperty("p", { action: "index", name: "app.plan" }, deps);
    assert.deepEqual(result, {
      ok: false,
      reason: "not_on_plan",
      error:
        "Indexing your own trace properties needs a paid plan: this plan indexes 0 of them per project. Standard properties are indexed on every plan.",
    });
    assert.deepEqual(calls, []);
  }
});

test("a plan's limit, and the hard cap of 20 whatever the plan answers", async () => {
  const limited = setup({ indexLimit: () => 5 }, 5);
  assert.deepEqual(
    await changeTraceProperty("p", { action: "index", name: "app.plan" }, limited.deps),
    {
      ok: false,
      reason: "limit",
      error:
        "This project indexes 5 trace properties of its own, and its plan allows 5. Indexing more of your own properties needs a larger paid plan.",
    },
  );
  const capped = setup({}, MAX_USER_INDEXED);
  assert.deepEqual(
    await changeTraceProperty("p", { action: "index", name: "app.plan" }, capped.deps),
    {
      ok: false,
      reason: "limit",
      error:
        "A project can index at most 20 trace properties of its own. Stop one to index another.",
    },
  );
  assert.deepEqual([...limited.calls, ...capped.calls], []);
});

test("a standard property turned off is indexed again on any plan", async () => {
  const { deps, calls } = setup({ indexLimit: () => 0 });
  await changeTraceProperty("p", { action: "stop", name: "organization" }, deps);
  const result = await changeTraceProperty("p", { action: "index", name: "organization" }, deps);
  assert.ok(result.ok);
  assert.deepEqual(calls.at(-1), ["fill", "p", ["organization"]]);
});

test("stop, then erase; stop with erase; a column property cannot be stopped", async () => {
  const { deps, calls } = setup();
  await changeTraceProperty("p", { action: "index", name: "app.plan" }, deps);
  const indexed = await changeTraceProperty("p", { action: "erase", name: "app.plan" }, deps);
  assert.deepEqual(indexed, {
    ok: false,
    reason: "invalid",
    error: "Stop indexing app.plan before you erase its values.",
  });
  const stopped = await changeTraceProperty("p", { action: "stop", name: "app.plan" }, deps);
  assert.ok(stopped.ok && stopped.property.state === "detected" && stopped.erased === undefined);
  const erased = await changeTraceProperty("p", { action: "erase", name: "app.plan" }, deps);
  assert.ok(erased.ok);
  assert.deepEqual(erased.erased, { spans: 3, traces: 1 });
  // Its values are gone: it holds none any more.
  assert.equal(erased.property.indexedAt, null);
  calls.length = 0;
  await changeTraceProperty("p", { action: "index", name: "organization" }, deps);
  const both = await changeTraceProperty(
    "p",
    { action: "stop", name: "organization", erase: true },
    deps,
  );
  assert.ok(both.ok && both.erased?.traces === 1);
  assert.deepEqual(calls.slice(-2), [
    ["setState", "p", "organization", "detected"],
    ["erase", "p", "organization"],
  ]);
  const column = await changeTraceProperty("p", { action: "stop", name: "user" }, deps);
  assert.deepEqual(column, {
    ok: false,
    reason: "invalid",
    error: "user is a column of every trace: it is always kept and cannot be stopped.",
  });
});

test("a member, a stranger, the flag off, a support session and an unknown key change nothing", async () => {
  const refused: [Partial<TracePropertyActionDeps>, RegExp][] = [
    [
      {
        findProjectScope: async () => ({
          project: { id: "p" },
          organization: { id: "o" },
          role: "member",
        }),
      },
      /^Only organization admins/,
    ],
    [{ findProjectScope: async () => null }, /^Only organization admins/],
    [{ enabled: async () => false }, /are off for this project\.$/],
    [{ isRestricted: async () => true }, /^A support session/],
  ];
  for (const [over, error] of refused) {
    const { deps, calls } = setup(over);
    const result = await changeTraceProperty("p", { action: "index", name: "app.plan" }, deps);
    assert.ok(!result.ok && error.test(result.error), String(error));
    assert.deepEqual(calls, []);
  }
  const { deps } = setup();
  const unknown = await changeTraceProperty("p", { action: "index", name: "app.nope" }, deps);
  assert.deepEqual(unknown, {
    ok: false,
    reason: "not_found",
    error: "This project's traces carry no property app.nope.",
  });
  const invalid = await changeTraceProperty("p", { action: "index" }, deps);
  assert.ok(!invalid.ok && invalid.reason === "invalid");
});
