import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createInMemoryUsageLimits } from "@/lib/contracts/usage-limits.fake";
import { createDrizzleBuildStore } from "../adapters/drizzle-build-store";
import { createDrizzleRetentionStore } from "../adapters/drizzle-retention-store";
import { createDrizzleRunStore } from "../adapters/drizzle-run-store";
import { createDrizzleSecretStore } from "../adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "../adapters/drizzle-version-store";
import { createDrizzleVmStore } from "../adapters/drizzle-vm-store";
import { snapshotName } from "../domain/snapshot-name";
import { startRun } from "../runs";
import { type SnapshotSweepDeps, sweepSnapshots } from "../snapshot-sweep";
import { createFakeProvider } from "./fake-provider";
import {
  bundleInfo,
  COMMIT,
  CONFIG,
  createSandboxDb,
  IMAGE,
  ORGANIZATION_ID,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  tarGz,
} from "./support";

const DEPLOYMENT = "test-deployment";
const KEEP = 2;

async function setup() {
  const { db, client } = await createSandboxDb();
  const versions = createDrizzleVersionStore(db);
  const builds = createDrizzleBuildStore(db);
  const runs = createDrizzleRunStore(db);
  const vms = createDrizzleVmStore(db);
  const provider = createFakeProvider({ deploymentId: DEPLOYMENT });
  let day = 0;
  /** Pushes a version of the sandbox `name` one day after the last one. */
  const push = async (name = CONFIG.name, projectId = PROJECT_ID) => {
    const created = await versions.create(
      {
        projectId,
        apiKeyId: null,
        config: { ...CONFIG, name },
        image: IMAGE,
        git: { commit: COMMIT, dirty: false },
        bundle: bundleInfo(tarGz([{ name: "a", body: "x" }])),
      },
      async () => ({ ok: true }),
    );
    assert.ok(created.ok);
    day += 1;
    const createdAt = new Date(Date.UTC(2026, 0, day)).toISOString();
    await client.query("update sandbox_versions set created_at = $1 where id = $2", [
      createdAt,
      created.version.id,
    ]);
    return created.version.id;
  };
  /** Builds a pushed version to ready, with a snapshot of the name `imageRef`. */
  const makeReady = async (
    versionId: string,
    projectId = PROJECT_ID,
    imageRef = snapshotName(DEPLOYMENT, versionId),
  ) => {
    await versions.markUploaded(projectId, versionId);
    await builds.claim(projectId, versionId, new Date());
    provider.snapshots.set(imageRef, new Map());
    const smoke = { ok: true as const, output: 1, durationMs: 1, logs: "" };
    await builds.finish(versionId, { status: "ready", imageRef, smoke, log: "" }, new Date());
    return versionId;
  };
  const pushReady = async (name?: string, projectId?: string) =>
    makeReady(await push(name, projectId), projectId);
  const deps: SnapshotSweepDeps = {
    store: createDrizzleRetentionStore(db),
    provider,
    deploymentId: DEPLOYMENT,
    holds: async () => new Set(),
    keep: KEEP,
  };
  const sweep = (more: Partial<SnapshotSweepDeps> = {}) => sweepSnapshots({ ...deps, ...more });
  const read = async (versionId: string, projectId = PROJECT_ID) => {
    const version = await versions.get(projectId, versionId);
    assert.ok(version);
    return version;
  };
  const runDeps = {
    runs,
    vms,
    versions,
    secrets: createDrizzleSecretStore(db),
    provider,
    limits: createInMemoryUsageLimits(),
    sealingKey: () => ({ ok: true as const, key: Buffer.alloc(32, 3) }),
    callbackUrl: () => "https://ratel.example",
    now: () => new Date(),
    background: () => {},
  };
  /** A queued run of the version, as a run start makes it. */
  const queueRun = (versionId: string) =>
    runs.create(
      {
        id: randomUUID(),
        projectId: PROJECT_ID,
        versionId,
        request: { runId: randomUUID() } as never,
        tokenHash: randomUUID(),
        traceId: "t",
        timeoutS: 60,
        requestedBy: "user_1",
      },
      async () => ({ ok: true }),
    );
  return {
    db,
    client,
    provider,
    versions,
    builds,
    push,
    makeReady,
    pushReady,
    sweep,
    read,
    runDeps,
    queueRun,
  };
}

test("the sweep keeps the newest N ready versions of a sandbox, retires the others and deletes their snapshots", async () => {
  const t = await setup();
  const [oldest, old, newer, newest] = [
    await t.pushReady(),
    await t.pushReady(),
    await t.pushReady(),
    await t.pushReady(),
  ];
  const other = await t.pushReady("billing-agent");

  const swept = await t.sweep();

  assert.equal(swept.retiredVersions, 2);
  assert.equal(swept.deletedSnapshots, 2);
  for (const id of [oldest, old]) {
    const version = await t.read(id);
    assert.equal(version.status, "retired");
    assert.equal(version.imageRef, null);
    assert.match(version.reason ?? "", /newest 2 versions/);
    assert.equal(t.provider.snapshots.has(snapshotName(DEPLOYMENT, id)), false);
  }
  for (const id of [newer, newest, other]) {
    assert.equal((await t.read(id)).status, "ready");
    assert.ok(t.provider.snapshots.has(snapshotName(DEPLOYMENT, id)));
  }
  assert.deepEqual(await t.sweep(), {
    retiredVersions: 0,
    deletedSnapshots: 0,
    orphanSnapshots: 0,
    snapshotErrors: 0,
  });
});

test("a version that an eval holds keeps its snapshot", async () => {
  const t = await setup();
  const pinned = await t.pushReady();
  const old = await t.pushReady();
  await t.pushReady();
  await t.pushReady();
  const swept = await t.sweep({ holds: async (ids) => new Set(ids.filter((id) => id === pinned)) });
  assert.equal(swept.retiredVersions, 1);
  assert.equal((await t.read(pinned)).status, "ready");
  assert.equal((await t.read(old)).status, "retired");
});

test("a version with a queued run or a live VM keeps its snapshot", async () => {
  const t = await setup();
  const queued = await t.pushReady();
  const warm = await t.pushReady();
  await t.pushReady();
  await t.pushReady();
  assert.ok((await t.queueRun(queued)).ok);
  await t.client.query(
    `insert into sandbox_vms (project_id, version_id, vm_ref, state, started_at, last_used_at)
     values ($1, $2, 'vm-1', 'ready', now(), now())`,
    [PROJECT_ID, warm],
  );
  const swept = await t.sweep();
  assert.equal(swept.retiredVersions, 0);
  assert.equal((await t.read(queued)).status, "ready");
  assert.equal((await t.read(warm)).status, "ready");
});

test("a version whose snapshot has an old name or a name of another deployment is never retired", async () => {
  const t = await setup();
  const legacy = await t.makeReady(await t.push(), PROJECT_ID, `rv-${randomUUID()}`);
  const foreign = await t.makeReady(await t.push(), PROJECT_ID, snapshotName("prod", randomUUID()));
  await t.pushReady();
  await t.pushReady();
  const before = [...t.provider.snapshots.keys()];
  const swept = await t.sweep();
  assert.equal(swept.retiredVersions, 0);
  assert.equal((await t.read(legacy)).status, "ready");
  assert.equal((await t.read(foreign)).status, "ready");
  assert.deepEqual([...t.provider.snapshots.keys()], before);
  assert.deepEqual(t.provider.deletedSnapshots, []);
});

test("a snapshot delete that fails leaves the version retired, and a later sweep deletes it", async () => {
  const t = await setup();
  const old = await t.pushReady();
  await t.pushReady();
  await t.pushReady();
  const deleteSnapshot = t.provider.deleteSnapshot;
  t.provider.deleteSnapshot = async () => {
    throw new Error("the service did not answer");
  };
  const failed = await t.sweep();
  assert.deepEqual([failed.retiredVersions, failed.deletedSnapshots], [1, 0]);
  assert.equal(failed.snapshotErrors, 1);
  const retired = await t.read(old);
  assert.equal(retired.status, "retired");
  assert.equal(retired.imageRef, snapshotName(DEPLOYMENT, old));

  t.provider.deleteSnapshot = deleteSnapshot;
  const again = await t.sweep();
  assert.deepEqual([again.retiredVersions, again.deletedSnapshots], [0, 1]);
  assert.equal((await t.read(old)).imageRef, null);
  assert.equal(t.provider.snapshots.has(snapshotName(DEPLOYMENT, old)), false);
});

test("a run of a retired version is refused with a clear message", async () => {
  const t = await setup();
  const old = await t.pushReady();
  await t.pushReady();
  await t.pushReady();
  await t.sweep();
  const started = await startRun(
    old,
    { message: "hi" },
    { projectId: PROJECT_ID, organizationId: ORGANIZATION_ID, requestedBy: "user_1" },
    t.runDeps,
  );
  assert.equal(started.ok, false);
  assert.ok(!started.ok && "message" in started);
  assert.equal(started.reason, "not_ready");
  assert.match(started.message, /retired/);
  assert.match(started.message, /newer version|push/i);
});

test("a run start that comes after the retire is refused in its own transaction", async () => {
  const t = await setup();
  const old = await t.pushReady();
  await t.pushReady();
  await t.pushReady();
  await t.sweep();
  const created = await t.queueRun(old);
  assert.equal(created.ok, false);
  const [{ count }] = (
    await t.client.query<{ count: number }>(
      "select count(*)::int as count from sandbox_runs where version_id = $1",
      [old],
    )
  ).rows as [{ count: number }];
  assert.equal(count, 0, "no run row of a retired version");
});

test("a project delete leaves orphan snapshots, and the sweep deletes them", async () => {
  const t = await setup();
  const gone = [
    await t.pushReady(CONFIG.name, OTHER_PROJECT_ID),
    await t.pushReady(CONFIG.name, OTHER_PROJECT_ID),
  ];
  const kept = await t.pushReady();
  const preparing = await t.push();
  // The build saved the snapshot, and the version is not ready yet: its row is there.
  t.provider.snapshots.set(snapshotName(DEPLOYMENT, preparing), new Map());
  await t.client.query("delete from projects where id = $1", [OTHER_PROJECT_ID]);

  const swept = await t.sweep();

  assert.equal(swept.orphanSnapshots, 2);
  for (const id of gone)
    assert.equal(t.provider.snapshots.has(snapshotName(DEPLOYMENT, id)), false);
  assert.ok(t.provider.snapshots.has(snapshotName(DEPLOYMENT, kept)));
  assert.ok(t.provider.snapshots.has(snapshotName(DEPLOYMENT, preparing)));
});

test("a build that stopped after the snapshot save leaves a failed version, and the sweep deletes its snapshot", async () => {
  const t = await setup();
  const stopped = await t.push();
  await t.versions.markUploaded(PROJECT_ID, stopped);
  await t.builds.claim(PROJECT_ID, stopped, new Date());
  // The worker saved the snapshot, then stopped before the smoke check ended.
  t.provider.snapshots.set(snapshotName(DEPLOYMENT, stopped), new Map());
  const later = new Date(Date.now() + 60_000);
  assert.equal(await t.builds.failStopped(later, "The build stopped.", later), 1);
  const kept = await t.pushReady();

  const swept = await t.sweep();

  assert.equal(swept.orphanSnapshots, 1);
  assert.equal(t.provider.snapshots.has(snapshotName(DEPLOYMENT, stopped)), false);
  assert.ok(t.provider.snapshots.has(snapshotName(DEPLOYMENT, kept)));
  assert.equal((await t.read(stopped)).status, "failed");
});

test("the orphan sweep does not touch a snapshot of another deployment or with an old name", async () => {
  const t = await setup();
  const names = [snapshotName("prod", randomUUID()), `rv-${randomUUID()}`, `rc-${randomUUID()}`];
  for (const name of names) t.provider.snapshots.set(name, new Map());
  const swept = await t.sweep();
  assert.equal(swept.orphanSnapshots, 0);
  assert.deepEqual([...t.provider.snapshots.keys()].sort(), [...names].sort());
  assert.deepEqual(t.provider.deletedSnapshots, []);
});

test("with no provider the sweep does nothing", async () => {
  const t = await setup();
  await t.pushReady();
  await t.pushReady();
  await t.pushReady();
  assert.deepEqual(await t.sweep({ provider: null }), {
    retiredVersions: 0,
    deletedSnapshots: 0,
    orphanSnapshots: 0,
    snapshotErrors: 0,
  });
});
