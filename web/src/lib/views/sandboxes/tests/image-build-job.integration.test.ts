import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { mock, test } from "node:test";
import { eq } from "drizzle-orm";
import { resolveConfig } from "@/config";
import { LONG_JOB_KINDS, SANDBOX_IMAGE_BUILD_JOB } from "@/lib/jobs/kinds";
import { reapStaleRunningJobs, STALE_JOB_MS } from "@/lib/jobs/queries";
import { jobs } from "@/lib/jobs/schema";
import { createDrizzleBuildStore } from "../adapters/drizzle-build-store";
import { createDrizzleVersionStore } from "../adapters/drizzle-version-store";
import { createLocalBundleStore } from "../adapters/local-bundle-store";
import { sandboxProvider, sandboxProviderConfigured } from "../adapters/provider-from-env";
import { bundleKey, versionView } from "../domain/version";
import {
  BUILD_STOPPED_MS,
  HEARTBEAT_MS,
  type ImageBuildDeps,
  NOT_CONFIGURED_REASON,
  runImageBuild,
  STOPPED_REASON,
} from "../image-build-job";
import type { SandboxProvider } from "../ports/sandbox-provider";
import { createFakeProvider } from "./fake-provider";
import { bundleInfo, COMMIT, createSandboxDb, MANIFEST, PROJECT_ID, tarGz } from "./support";

const BUNDLE = tarGz([{ name: "src/agent.ts", body: "x" }]);

async function setup(over: { install?: string[]; stored?: Buffer } = {}) {
  const { db } = await createSandboxDb();
  const versions = createDrizzleVersionStore(db);
  const builds = createDrizzleBuildStore(db);
  const bundles = createLocalBundleStore(mkdtempSync(join(tmpdir(), "bundles-")));
  const created = await versions.create(
    {
      projectId: PROJECT_ID,
      apiKeyId: null,
      manifest: { ...MANIFEST, install: over.install ?? MANIFEST.install },
      git: { commit: COMMIT, dirty: false },
      bundle: bundleInfo(BUNDLE),
    },
    async () => ({ ok: true }),
  );
  assert.ok(created.ok);
  const { version } = created;
  const stored = over.stored ?? BUNDLE;
  await bundles.put(bundleKey(version), chunk(stored), bundleInfo(stored));
  await versions.markUploaded(PROJECT_ID, version.id);
  const provider = createFakeProvider();
  const deps: ImageBuildDeps = {
    builds,
    bundles,
    provider,
    now: () => new Date(),
    every: () => () => {},
  };
  const run = (more: Partial<ImageBuildDeps> = {}) =>
    runImageBuild(PROJECT_ID, { versionId: version.id }, { ...deps, ...more });
  const read = async () => {
    const found = await versions.get(PROJECT_ID, version.id);
    assert.ok(found);
    return found;
  };
  return { db, deps, version, builds, provider, run, read };
}

test("a build goes building, then ready with an image reference and a log", async () => {
  const t = await setup();
  let during = "";
  const provider: SandboxProvider = {
    ...t.provider,
    buildImage: async (request) => {
      during = (await t.read()).status;
      return t.provider.buildImage(request);
    },
  };
  assert.deepEqual(await t.run({ provider }), { status: "ready" });
  assert.equal(during, "building");
  const built = await t.read();
  assert.equal(built.status, "ready");
  assert.match(built.imageRef ?? "", /^im-/);
  assert.match(built.buildLog ?? "", /install command 1 \(npm install\)/);
  assert.equal(JSON.stringify(versionView(built)).includes(built.imageRef ?? "?"), false);
});

test("a second job for the same version builds nothing", async () => {
  const t = await setup();
  await t.run();
  const { imageRef } = await t.read();
  assert.deepEqual(await t.run(), { status: "skipped" });
  assert.equal(t.provider.builds.length, 1);
  assert.equal((await t.read()).imageRef, imageRef);
});

test("a failed install gives failed with a reason and a log", async () => {
  const t = await setup({ install: ["exit 3"] });
  await t.run();
  const failed = await t.read();
  assert.equal(failed.status, "failed");
  assert.match(failed.reason ?? "", /install command 1 \(exit 3\) failed/);
  assert.match(failed.buildLog ?? "", /no luck/);
  assert.equal(failed.imageRef, null);
});

test("a wrong bundle hash fails the build", async () => {
  const t = await setup({ stored: tarGz([{ name: "other.ts", body: "y" }]) });
  await t.run();
  const failed = await t.read();
  assert.equal(failed.status, "failed");
  assert.match(failed.reason ?? "", /checking the bundle failed/);
});

test("a provider error fails the build, and its text is not shown", async () => {
  const t = await setup();
  const provider: SandboxProvider = {
    ...t.provider,
    buildImage: async () => {
      throw new Error("modal.com refused account-123");
    },
  };
  await t.run({ provider });
  const failed = await t.read();
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(`${failed.reason}${failed.buildLog}`, /modal|account-123/i);
});

test("a long log keeps its end", async () => {
  const t = await setup();
  const provider: SandboxProvider = {
    ...t.provider,
    buildImage: async ({ log }) => {
      for (let i = 0; i < 20_000; i++) log(`line ${i} \0 filler\n`);
      return { imageRef: "im-1" };
    },
  };
  await t.run({ provider });
  const log = (await t.read()).buildLog ?? "";
  assert.ok(log.length < 70_000);
  assert.match(log, /^\[the start of the log is cut\]/);
  assert.match(log, /line 19999/);
});

test("with no provider the version stays unbuilt with the reason, and no call goes out", async () => {
  const t = await setup();
  const calls = mock.method(globalThis, "fetch", async () => {
    throw new Error("an outbound call");
  });
  const provider = sandboxProvider(resolveConfig());
  assert.equal(provider, null);
  assert.equal(sandboxProviderConfigured(resolveConfig()), false);
  assert.deepEqual(await t.run({ provider }), { status: "unbuilt" });
  const version = await t.read();
  assert.equal(version.status, "uploaded");
  assert.equal(version.reason, NOT_CONFIGURED_REASON);
  assert.match(NOT_CONFIGURED_REASON, /not configured/);
  assert.equal(calls.mock.callCount(), 0);
  mock.restoreAll();
});

test("a build of 12 minutes is not reaped, and a build with no heartbeat is", async () => {
  const t = await setup();
  const start = Date.now();
  let clock = start;
  const [job] = await t.db
    .insert(jobs)
    .values({
      projectId: PROJECT_ID,
      kind: SANDBOX_IMAGE_BUILD_JOB,
      status: "running",
      payload: { versionId: t.version.id },
      startedAt: new Date(start),
    })
    .returning();
  const reap = async () =>
    reapStaleRunningJobs(
      new Date(clock - STALE_JOB_MS),
      t.db,
      await t.builds.liveJobIds(new Date(clock - BUILD_STOPPED_MS)),
    );
  let beat = () => {};
  const provider: SandboxProvider = {
    ...t.provider,
    buildImage: async (request) => {
      while (clock < start + 12 * 60_000) {
        clock += HEARTBEAT_MS;
        beat();
        await new Promise((resolve) => setTimeout(resolve, 1));
        assert.equal(await reap(), 0, `reaped after ${(clock - start) / 60_000} minutes`);
        const since = new Date(clock - BUILD_STOPPED_MS);
        assert.equal(await t.builds.failStopped(since, STOPPED_REASON, new Date(clock)), 0);
      }
      return t.provider.buildImage(request);
    },
  };
  const result = await t.run({
    provider,
    now: () => new Date(clock),
    every: (_ms, work) => {
      beat = work;
      return () => {};
    },
  });
  assert.deepEqual(result, { status: "ready" });

  // The process of another build ends: no heartbeat any more.
  await t.db.execute("update sandbox_versions set status = 'building'");
  clock += BUILD_STOPPED_MS + 60_000;
  assert.equal(await reap(), 1);
  const [reaped] = await t.db.select().from(jobs).where(eq(jobs.id, job.id));
  assert.equal(reaped.status, "error");
  const since = new Date(clock - BUILD_STOPPED_MS);
  assert.equal(await t.builds.failStopped(since, STOPPED_REASON, new Date(clock)), 1);
  assert.equal((await t.read()).status, "failed");
});

test("an uploaded version with no job is found, one time", async () => {
  const t = await setup();
  const later = new Date(Date.now() + 60_000);
  const expected = [{ projectId: PROJECT_ID, versionId: t.version.id }];
  assert.deepEqual(await t.builds.listUnqueued(new Date(0)), []);
  assert.deepEqual(await t.builds.listUnqueued(later), expected);
  await t.db.insert(jobs).values({
    projectId: PROJECT_ID,
    kind: SANDBOX_IMAGE_BUILD_JOB,
    payload: { versionId: t.version.id },
  });
  assert.deepEqual(await t.builds.listUnqueued(later), []);
});

test("a build that the provider never answers fails at its deadline", async () => {
  const t = await setup();
  const provider: SandboxProvider = {
    ...createFakeProvider(),
    buildImage: () => new Promise(() => {}),
  };
  const result = await t.run({ provider, deadlineMs: 20 });
  assert.deepEqual(result, { status: "failed" });
  assert.equal((await t.read()).reason, "The build took too long. Push again.");
});

test("a build runs in the lane of long jobs", () => {
  assert.ok((LONG_JOB_KINDS as readonly string[]).includes(SANDBOX_IMAGE_BUILD_JOB));
});

async function* chunk(body: Buffer) {
  yield body;
}

test("the bundle opens when the provider reads it, and closes when the build breaks", async () => {
  const t = await setup();
  const body = Readable.from([BUNDLE, BUNDLE]);
  let opened = 0;
  const bundles = {
    ...t.deps.bundles,
    open: async () => {
      opened += 1;
      return body;
    },
  };
  const before: number[] = [];
  const provider: SandboxProvider = {
    ...createFakeProvider(),
    async buildImage(request) {
      before.push(opened);
      for await (const _ of request.bundle.body) throw new Error("lost");
      return { imageRef: "im-x" };
    },
  };
  assert.deepEqual(await t.run({ bundles, provider }), { status: "failed" });
  assert.deepEqual(before, [0]);
  assert.equal(body.destroyed, true);
});
