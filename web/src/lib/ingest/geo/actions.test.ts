import assert from "node:assert/strict";
import { test } from "node:test";
import { changeGeoAttributes, type GeoActionDeps } from "@/lib/ingest/geo/actions";
import { DEFAULT_GEO_ATTRIBUTES } from "@/lib/ingest/geo/attributes";

const CHANGED = { ...DEFAULT_GEO_ATTRIBUTES, address: "app.ip" };

test("F452-1: a member, a stranger, the flag off and a support session change nothing; an admin does", async () => {
  const refused: [Partial<GeoActionDeps>, RegExp][] = [
    [scope("member"), /^Only organization admins/],
    [scope(null), /^Only organization admins/],
    [{ findProjectScope: async () => null }, /^Only organization admins/],
    [{ enabled: async () => false }, /are off/],
    [{ isRestricted: async () => true }, /^A support session/],
  ];
  for (const [over, error] of refused) {
    const { deps, saved } = setup(over);
    const result = await changeGeoAttributes("p", CHANGED, deps);
    assert.ok(!result.ok && error.test(result.error), String(error));
    assert.deepEqual(saved, []);
  }
  const { deps, saved } = setup();
  assert.deepEqual(await changeGeoAttributes("p", CHANGED, deps), {
    ok: true,
    attributes: CHANGED,
  });
  assert.deepEqual(saved, [["p", CHANGED]]);
  const invalid = await changeGeoAttributes("p", { ...CHANGED, address: "server.address" }, deps);
  assert.ok(!invalid.ok && /must not be stored/.test(invalid.error));
  assert.equal((await changeGeoAttributes("p", { ...CHANGED, country: "a\0" }, deps)).ok, false);
  assert.equal(saved.length, 1);
});

function scope(role: string | null): Partial<GeoActionDeps> {
  return {
    findProjectScope: async (id) => ({ project: { id }, organization: { id: "o" }, role }),
  };
}

function setup(over: Partial<GeoActionDeps> = {}) {
  const saved: unknown[] = [];
  const deps = {
    ...scope("admin"),
    enabled: async () => true,
    isRestricted: async () => false,
    save: async (...args: unknown[]) => {
      saved.push(args);
    },
    observe: async () => {},
    ...over,
  } as GeoActionDeps;
  return { deps, saved };
}
