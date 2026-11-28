import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type ReadyVersion, versionsToRetire } from "../domain/retention";
import { snapshotName, snapshotVersionId } from "../domain/snapshot-name";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "33333333-3333-4333-8333-333333333333";

/** A ready version `id` of the sandbox `name`, pushed on day `day`. */
function ready(id: string, day: number, name = "agent", projectId = P1): ReadyVersion {
  return { id, projectId, name, createdAt: new Date(Date.UTC(2026, 0, day)) };
}

const ids = (versions: readonly ReadyVersion[]) => versions.map((v) => v.id).sort();

describe("versionsToRetire", () => {
  test("keeps the newest N of each sandbox name and retires the older ones", () => {
    const versions = [ready("a1", 1), ready("a4", 4), ready("a2", 2), ready("a3", 3)];
    assert.deepEqual(ids(versionsToRetire(versions, 2, new Set())), ["a1", "a2"]);
  });

  test("counts each sandbox name and each project apart", () => {
    const versions = [
      ready("a1", 1),
      ready("a2", 2),
      ready("b1", 1, "billing"),
      ready("c1", 1, "agent", P2),
    ];
    assert.deepEqual(ids(versionsToRetire(versions, 1, new Set())), ["a1"]);
  });

  test("keeps an old version that a pinned eval baseline uses", () => {
    const versions = [ready("pinned", 1), ready("old", 2), ready("new", 3)];
    assert.deepEqual(ids(versionsToRetire(versions, 1, new Set(["pinned"]))), ["old"]);
  });

  test("keeps an old version that a running eval experiment uses", () => {
    const versions = [ready("old", 1), ready("experiment", 2), ready("new", 3)];
    assert.deepEqual(ids(versionsToRetire(versions, 1, new Set(["experiment"]))), ["old"]);
  });

  test("keeps an old version that an active run uses", () => {
    const versions = [ready("running", 1), ready("new", 2)];
    assert.deepEqual(ids(versionsToRetire(versions, 1, new Set(["running"]))), []);
  });

  test("a held version does not take a place of the newest N", () => {
    const versions = [ready("a1", 1), ready("a2", 2), ready("a3", 3)];
    assert.deepEqual(ids(versionsToRetire(versions, 2, new Set(["a3"]))), ["a1"]);
  });
});

describe("snapshot names", () => {
  const VERSION = "0b6c1f0e-5d0a-4c55-9f4e-3d2b1a0f9e8d";

  test("a name carries the deployment and the version, in the pattern of the service", () => {
    const name = snapshotName("staging", VERSION);
    assert.equal(name, `rv-staging-${VERSION}`);
    assert.match(name, /^[a-z0-9][a-z0-9-]{0,62}$/);
    assert.equal(snapshotVersionId("staging", name), VERSION);
  });

  test("a long deployment id gives a short tag, and the name stays under 63 characters", () => {
    const long = "a".repeat(63);
    const name = snapshotName(long, VERSION);
    assert.ok(name.length <= 63, name);
    assert.match(name, /^[a-z0-9][a-z0-9-]{0,62}$/);
    assert.equal(snapshotVersionId(long, name), VERSION);
    assert.notEqual(name, snapshotName("a".repeat(62), VERSION));
  });

  test("a name of another deployment or an old name has no version of this deployment", () => {
    assert.equal(snapshotVersionId("prod", snapshotName("staging", VERSION)), null);
    assert.equal(snapshotVersionId("staging", snapshotName("staging-2", VERSION)), null);
    assert.equal(snapshotVersionId("staging", `rv-${VERSION}`), null);
    assert.equal(snapshotVersionId("staging", "rv-staging-not-a-uuid"), null);
    assert.equal(snapshotVersionId("staging", `rc-staging-${VERSION}`), null);
  });
});
