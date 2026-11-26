import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createInMemoryUsageLimits } from "@/lib/contracts/usage-limits.fake";
import { sealSecret } from "@/lib/platform/sealed-secrets";
import { createDrizzleBuildStore } from "../adapters/drizzle-build-store";
import { createDrizzleRunStore } from "../adapters/drizzle-run-store";
import { createDrizzleSecretStore } from "../adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "../adapters/drizzle-version-store";
import { createDrizzleVmStore } from "../adapters/drizzle-vm-store";
import { createLocalBundleStore } from "../adapters/local-bundle-store";
import { createLocalDockerProvider } from "../adapters/local-docker-provider";
import type { RatelYaml } from "../domain/config";
import { bundleKey } from "../domain/version";
import { type ImageBuildDeps, runImageBuild } from "../image-build-job";
import type { SandboxProvider } from "../ports/sandbox-provider";
import { type RunDeps, startRun } from "../runs";
import {
  bundleInfo,
  COMMIT,
  CONFIG,
  createSandboxDb,
  DOCKER_SKIP,
  dockerAnswers,
  IMAGE,
  ORGANIZATION_ID,
  PROJECT_ID,
  tarGz,
} from "./support";

/**
 * The image build job and runs on the local Docker provider, with a real image: a busybox HTTP
 * agent that answers `/ratel/health` and echoes the run request as its output. Values with shell
 * characters go through a param, a secret and the name of an image: none runs.
 */
const ID = randomUUID().slice(0, 8);
const DEPLOYMENT = `e2e-${ID}`;
const AGENT_IMAGE = `ratel-e2e-agent:${ID}`;
const KEY = Buffer.alloc(32, 5);
/** Each marker that an injected command would make. */
const MARKERS = ["/tmp/pwned", "/tmp/pwned-tag", "/tmp/pwned-param", "/tmp/pwned-secret"];
const EVIL_PARAM = `$(touch /tmp/pwned-param); \`touch /tmp/pwned\` 'a' "b" | ;`;
const EVIL_SECRET = `$(touch /tmp/pwned-secret)';touch /tmp/pwned;'"`;
const EVIL_TAG = "evil$(touch /tmp/pwned-tag);`touch /tmp/pwned`:x";
const COMMAND_CONFIG = {
  ...CONFIG,
  run: { mode: "command", command: ["sh", "/agent/answer.sh"], timeoutSeconds: 60 },
} satisfies RatelYaml;

/** Reads one HTTP request on stdin (nc -e) and answers it. */
const HANDLE_SH = `read -r method path proto
len=0
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d '\\r')
  [ -z "$line" ] && break
  case "$line" in [Cc]ontent-[Ll]ength:*) len=$(printf '%s' "\${line#*:}" | tr -d ' ') ;; esac
done
body=""
[ "$len" -gt 0 ] && body=$(head -c "$len")
case "$path" in
  /ratel/health) out='{"ok":true}' ;;
  /ratel/run) out=$(printf '%s' "$body" | sh /agent/answer.sh) ;;
  *) out='{}' ;;
esac
size=$(printf '%s' "$out" | wc -c | tr -d ' ')
printf 'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\n\\r\\n%s' "$size" "$out"
`;
const ANSWER_SH = `req=$(cat)
printf '{"output":{"agent":"e2e","secretSet":%s,"echo":%s}}' "$([ -n "$OPENAI_API_KEY" ] && echo true || echo false)" "$req"
`;
const AGENT_DOCKERFILE = `FROM busybox:1.37
COPY handle.sh answer.sh /agent/
CMD ["sh", "-c", "exec nc -lk -p \\"\${PORT:-8080}\\" -e sh /agent/handle.sh"]
`;

const docker = dockerAnswers();

describe("local Docker provider, end to end", {
  skip: docker ? false : `${DOCKER_SKIP}: local-docker end-to-end skipped`,
  timeout: 900_000,
}, () => {
  let work: string;
  let bundle: Buffer;
  let provider: SandboxProvider;
  /** The VMs that were deleted, each with the markers found in it just before. */
  const checked: Array<{ vmRef: string; markers: string }> = [];
  /** Each VM start: its purpose and its snapshot. */
  const starts: Array<{ purpose: string; fromSnapshot?: string; keepSnapshots: boolean }> = [];
  const snapshots: string[] = [];

  before(() => {
    work = mkdtempSync(join(tmpdir(), "ratel-e2e-"));
    const context = tarGz([
      { name: "Dockerfile", body: AGENT_DOCKERFILE },
      { name: "handle.sh", body: HANDLE_SH },
      { name: "answer.sh", body: ANSWER_SH },
    ]);
    dockerOk(["build", "--quiet", "--tag", AGENT_IMAGE, "-"], context);
    bundle = dockerOk(["save", AGENT_IMAGE]);
    const local = createLocalDockerProvider({ deploymentId: DEPLOYMENT });
    // Each VM is searched for the markers before it goes.
    provider = {
      ...local,
      startVm(request) {
        const { purpose, fromSnapshot, keepSnapshots } = request;
        starts.push({ purpose, fromSnapshot, keepSnapshots });
        return local.startVm(request);
      },
      async deleteVm(vmRef) {
        const found = await local
          .exec(vmRef, { command: `ls -1d ${MARKERS.join(" ")} 2>/dev/null; true`, timeoutS: 30 })
          .catch(() => ({ stdout: "" }));
        checked.push({ vmRef, markers: found.stdout.trim() });
        return local.deleteVm(vmRef);
      },
    };
  });

  after(async () => {
    const left = await provider.listVms({}).catch(() => []);
    for (const vm of left) await provider.deleteVm(vm.vmRef).catch(() => undefined);
    for (const name of snapshots) await provider.deleteSnapshot(name).catch(() => undefined);
    spawnSync("docker", ["image", "rm", "-f", AGENT_IMAGE]);
    rmSync(work, { recursive: true, force: true });
  });

  test("a pushed image gets ready, runs in HTTP and command mode, reuses its VM and cleans up", {
    timeout: 600_000,
  }, async () => {
    const t = await setup(provider, work);
    const http = await t.version(CONFIG, bundle);
    await t.ready(http);
    const ready = await t.versions.get(PROJECT_ID, http);
    assert.equal(ready?.status, "ready", ready?.reason ?? "");
    assert.equal(ready?.smoke?.ok, true);
    snapshots.push(ready?.imageRef ?? "");
    // The snapshot comes from a prepare VM; the smoke check runs in a second VM from it.
    assert.deepEqual(starts, [
      { purpose: "prepare", fromSnapshot: undefined, keepSnapshots: true },
      { purpose: "smoke", fromSnapshot: ready?.imageRef, keepSnapshots: false },
    ]);
    assert.equal(listed(["ps", "-a", "--filter", `label=ratel-deployment=${DEPLOYMENT}`]), "");
    assert.deepEqual(
      (ready?.smoke as { output: { echo: { input: unknown } } }).output.echo.input,
      CONFIG.input.example,
    );

    const first = await t.run(http, { params: { model: EVIL_PARAM } });
    assert.equal(first.status, "completed", `${first.errorCode}: ${first.reason}`);
    const output = first.response?.output as {
      echo: { params: Record<string, unknown> };
      secretSet: boolean;
    };
    assert.equal(output.echo.params.model, EVIL_PARAM);
    assert.equal(output.secretSet, true);
    const second = await t.run(http, {});
    assert.equal(second.status, "completed", `${second.errorCode}: ${second.reason}`);
    assert.equal(second.vmId, first.vmId, "the second run reuses the VM of the first");
    assert.equal(second.instanceRef, first.instanceRef);

    const command = await t.version(COMMAND_CONFIG, bundle);
    await t.ready(command);
    snapshots.push((await t.versions.get(PROJECT_ID, command))?.imageRef ?? "");
    const third = await t.run(command, { params: { model: EVIL_PARAM } });
    assert.equal(third.status, "completed", `${third.errorCode}: ${third.reason}`);
    assert.equal((third.response?.output as { agent: string }).agent, "e2e");

    // No run container, volume or file stays in a run VM.
    for (const vmRef of new Set([first.instanceRef, third.instanceRef])) {
      const left = await provider.exec(vmRef ?? "", {
        command: "docker ps -aq; docker volume ls -q; ls -1d /tmp/ratel-run-* 2>/dev/null; true",
        timeoutS: 60,
      });
      assert.equal(left.stdout.trim(), "", `left in ${vmRef}`);
    }
    for (const vm of await provider.listVms({})) await provider.deleteVm(vm.vmRef);
    assert.equal(listed(["ps", "-a", "--filter", `label=ratel-deployment=${DEPLOYMENT}`]), "");
    assert.deepEqual(
      checked.filter((vm) => vm.markers),
      [],
    );
    for (const marker of MARKERS) assert.equal(existsSync(marker), false, marker);
  });

  test("an image whose name holds shell characters runs or is refused, and nothing is injected", {
    timeout: 300_000,
  }, async () => {
    const t = await setup(provider, work);
    const renamed = renameImage(bundle, EVIL_TAG, work);
    const version = await t.version(CONFIG, renamed);
    const searched = checked.length;
    const built = await t.build(version);
    const read = await t.versions.get(PROJECT_ID, version);
    if (built.status === "ready") {
      snapshots.push(read?.imageRef ?? "");
      const run = await t.run(version, { params: { model: EVIL_PARAM } });
      assert.equal(run.status, "completed", `${run.errorCode}: ${run.reason}`);
      for (const vm of await provider.listVms({})) await provider.deleteVm(vm.vmRef);
    } else {
      assert.equal(read?.status, "failed");
    }
    assert.ok(checked.length > searched, "the VMs were searched");
    assert.deepEqual(
      checked.filter((vm) => vm.markers),
      [],
    );
    for (const marker of MARKERS) assert.equal(existsSync(marker), false, marker);
  });
});

async function setup(provider: SandboxProvider, work: string) {
  const { db } = await createSandboxDb();
  const versions = createDrizzleVersionStore(db);
  const builds = createDrizzleBuildStore(db);
  const secrets = createDrizzleSecretStore(db);
  const runs = createDrizzleRunStore(db);
  const vms = createDrizzleVmStore(db);
  const dir = join(work, randomUUID());
  mkdirSync(dir);
  const bundles = createLocalBundleStore(dir);
  const sealed = sealSecret(KEY, { projectId: PROJECT_ID, name: "OPENAI_API_KEY" }, EVIL_SECRET);
  await secrets.set(PROJECT_ID, "OPENAI_API_KEY", sealed, "user_1");
  const pending: Array<Promise<void>> = [];
  const buildDeps: ImageBuildDeps = {
    builds,
    bundles,
    provider,
    secrets,
    vms,
    limits: createInMemoryUsageLimits(),
    organizationIdOf: async () => ORGANIZATION_ID,
    callbackUrl: () => "http://127.0.0.1:9",
    sealingKey: () => ({ ok: true, key: KEY }),
    enabled: async () => true,
    now: () => new Date(),
    every: () => () => {},
  };
  const runDeps: RunDeps = {
    runs,
    vms,
    versions,
    secrets,
    provider,
    limits: createInMemoryUsageLimits(),
    sealingKey: () => ({ ok: true, key: KEY }),
    callbackUrl: () => "http://127.0.0.1:9",
    now: () => new Date(),
    background: (task) => {
      pending.push(task());
    },
  };
  return {
    versions,
    /** A pushed version of this tarball. */
    async version(config: RatelYaml, tarball: Buffer): Promise<string> {
      const created = await versions.create(
        {
          projectId: PROJECT_ID,
          apiKeyId: null,
          config,
          image: IMAGE,
          git: { commit: COMMIT, dirty: false },
          bundle: bundleInfo(tarball),
        },
        async () => ({ ok: true }),
      );
      assert.ok(created.ok);
      await bundles.put(bundleKey(created.version), chunks(tarball), bundleInfo(tarball));
      await versions.markUploaded(PROJECT_ID, created.version.id);
      return created.version.id;
    },
    build: (versionId: string) => runImageBuild(PROJECT_ID, { versionId }, buildDeps),
    /** Builds a version that must get ready. A failure shows the reason and the log. */
    async ready(versionId: string): Promise<void> {
      await runImageBuild(PROJECT_ID, { versionId }, buildDeps);
      const read = await versions.get(PROJECT_ID, versionId);
      assert.equal(
        read?.status,
        "ready",
        `${read?.reason}\n${read?.buildLog}\n${JSON.stringify(read?.smoke)}`,
      );
    },
    /** Starts a run and waits for its end. */
    async run(versionId: string, options: { params?: Record<string, unknown> }) {
      const started = await startRun(
        versionId,
        { message: "hi" },
        {
          projectId: PROJECT_ID,
          organizationId: ORGANIZATION_ID,
          requestedBy: "user_1",
          ...options,
        },
        runDeps,
      );
      assert.ok(started.ok, JSON.stringify(started));
      for (let task = pending.shift(); task; task = pending.shift()) await task;
      const run = await runs.get(PROJECT_ID, started.run.id);
      assert.ok(run);
      return run;
    },
  };
}

/** The tarball of `docker save` with the image named `name` in its manifests. */
function renameImage(tarball: Buffer, name: string, work: string): Buffer {
  const dir = mkdtempSync(join(work, "renamed-"));
  writeFileSync(join(dir, "in.tar"), tarball);
  const tree = join(dir, "tree");
  mkdirSync(tree);
  run("tar", ["-xf", join(dir, "in.tar"), "-C", tree]);
  const manifestPath = join(tree, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Array<{ RepoTags?: string[] }>;
  for (const entry of manifest) entry.RepoTags = [name];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const indexPath = join(tree, "index.json");
  if (existsSync(indexPath)) {
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
      manifests?: Array<{ annotations?: Record<string, string> }>;
    };
    for (const entry of index.manifests ?? []) {
      entry.annotations = {
        ...entry.annotations,
        "io.containerd.image.name": `docker.io/library/${name}`,
        "org.opencontainers.image.ref.name": name.slice(name.lastIndexOf(":") + 1),
      };
    }
    writeFileSync(indexPath, JSON.stringify(index));
  }
  run("tar", ["-cf", join(dir, "out.tar"), "-C", tree, "."]);
  return readFileSync(join(dir, "out.tar"));
}

function dockerOk(args: string[], input?: Buffer): Buffer {
  return run("docker", args, input);
}

function listed(args: string[]): string {
  return dockerOk(args).toString().trim().split("\n").slice(1).join("\n");
}

function run(file: string, args: string[], input?: Buffer): Buffer {
  const done = spawnSync(file, args, { input, maxBuffer: 512 * 1024 * 1024, timeout: 300_000 });
  assert.equal(done.status, 0, `${file} ${args[0]}: ${done.stderr?.toString()}`);
  return done.stdout;
}

async function* chunks(body: Buffer) {
  for (let at = 0; at < body.length; at += 64 * 1024) yield body.subarray(at, at + 64 * 1024);
}
