import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { getLogger } from "@/lib/platform/logger";
import {
  type ExecResult,
  ProviderRefused,
  ProviderUnavailable,
  type SandboxProvider,
  type StartVmRequest,
  type VmState,
} from "../ports/sandbox-provider";

/**
 * {@link SandboxProvider} on the local Docker daemon, through the `docker` CLI: real runs of real
 * images with no account of a VM service. For development and proof only.
 *
 * A VM is one privileged Docker-in-Docker container (`ratel-vm-<12 hex>`) of a small local image
 * (`ratel-local-vm:<hash of its Dockerfile>`, built on first use from `docker:29-dind`). Each VM has
 * its own Docker daemon, its own images and its own loopback, as a VM of the service has: `docker
 * load`, `docker run -p 127.0.0.1::<port>`, `curl 127.0.0.1:<port>`, `docker ps -aq` and `docker
 * volume ls -q` of the runner see only the VM. The daemon keeps its data in the anonymous volume of
 * `/var/lib/docker`.
 *
 * A snapshot is two things with the same key (a hash of the deployment and the name): the image
 * `ratel-local-snap:<key>`, a `docker commit` of the stopped VM (its files, `/home/user` included),
 * and the volume `ratel-local-snap-<key>`, a copy of its Docker data (the loaded images). Both carry
 * the labels of the name and of the deployment. A VM starts from a snapshot with a copy of that
 * volume, so a snapshot is never in use and is always deleted.
 *
 * The TTL holds two ways: the daemon of the VM ends after `ttlS` (the VM stops), and each `startVm`
 * deletes the VMs of the deployment whose TTL is over.
 *
 * Limits: the network policy of a start is taken and ignored (inbound and outbound are open: there
 * is no outbound allow-list). There is no VM isolation: a VM is a privileged container, so code in
 * it is root on the host daemon. Every Docker call is an argument array, never a shell line: a
 * command of `exec` goes to `bash -c` in the VM as one argument, exactly as the service takes it. A
 * written file has the mode 600, and no message or log holds a value of a file.
 */
export type LocalDockerProviderOptions = {
  /** The value of the `ratel-deployment` label (`provider-from-env.ts`). */
  deploymentId: string;
  /** The Docker CLI. The `docker` binary by default. */
  docker?: DockerCli;
  /** The limit of the Docker wait of a start. */
  readyTimeoutMs?: number;
};

/** One call of the Docker CLI with these arguments. Its stdin, when given, is written and closed. */
export type DockerCli = (
  args: readonly string[],
  options?: DockerCallOptions,
) => Promise<DockerCall>;

export type DockerCallOptions = {
  stdin?: string | Uint8Array | AsyncIterable<Uint8Array>;
  /** The CLI is killed after this time, and the call answers `timedOut`. */
  timeoutMs?: number;
};

export type DockerCall = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const VM_PREFIX = "ratel-vm-";
const VM_REF = /^ratel-vm-[a-f0-9]{12}$/;
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEPLOYMENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A file under `/tmp` or `/home/user`, with plain path segments only. */
const FILE_PATH = /^\/(?:tmp|home\/user)(?:\/[A-Za-z0-9._-]+)+$/;
const DEPLOYMENT_LABEL = "ratel-deployment";
const VM_LABEL = "ratel-local-vm";
const EXPIRES_LABEL = "ratel-local-expires-at";
const SNAPSHOT_LABEL = "ratel-local-snapshot";
const SNAPSHOT_IMAGE = "ratel-local-snap";
const DOCKER_DATA = "/var/lib/docker";
/** The image of a VM: Docker-in-Docker with the tools of the runner's commands. */
const DOCKERFILE = [
  "FROM docker:29-dind",
  "RUN apk add --no-cache bash curl coreutils procps util-linux && mkdir -p /home/user",
  `RUN printf '%s\\n' '#!/bin/sh' 'rm -f /var/run/docker.pid /var/run/docker/containerd/containerd.pid' 'exec timeout -s TERM "\${RATEL_TTL_S:-7200}" dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock' > /usr/local/bin/ratel-vm-init && chmod 755 /usr/local/bin/ratel-vm-init`,
  'ENV DOCKER_TLS_CERTDIR=""',
  `LABEL ${VM_LABEL}-image=1`,
  'ENTRYPOINT ["/usr/local/bin/ratel-vm-init"]',
  "",
].join("\n");
export const LOCAL_VM_IMAGE = `ratel-local-vm:${createHash("sha256").update(DOCKERFILE).digest("hex").slice(0, 12)}`;
/** Writes stdin to the file named by `$1`, with the mode 600. The path is never in the script. */
const WRITE_SCRIPT = 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1"';
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 500;
/** The kill of a command after its timeout, and the end of the CLI after that. */
const KILL_AFTER_S = 5;
const EXEC_SLACK_S = 15;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const STEP_TIMEOUT_MS = 10 * 60_000;
/** `timeout` ends with 124 when the time is over, and with 137 after its kill. */
const TIMED_OUT_CODES = new Set([124, 137]);
const GONE = /No such (container|object)|is not running/;

const logger = getLogger("sandboxes/local-docker-provider");

export function createLocalDockerProvider(options: LocalDockerProviderOptions): SandboxProvider {
  const { deploymentId } = options;
  if (!DEPLOYMENT_ID.test(deploymentId)) {
    throw new Error(`The deployment id ${deploymentId} is not a plain label value.`);
  }
  const docker = options.docker ?? dockerCli;
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  let helper: Promise<string> | undefined;
  const keyOf = (name: string) => snapshotKeyOf(deploymentId, name);

  const provider: SandboxProvider = {
    async startVm(request) {
      const labels = vmLabels(request, deploymentId);
      await deleteExpired();
      const base = await helperImage();
      const snapshot = request.fromSnapshot ? await snapshotKey(request.fromSnapshot) : null;
      const vmRef = `${VM_PREFIX}${randomBytes(6).toString("hex")}`;
      await must(
        [
          "create",
          "--privileged",
          "--name",
          vmRef,
          ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
          "--env",
          `RATEL_TTL_S=${Math.max(1, Math.ceil(request.ttlS))}`,
          snapshot ? snapshotImage(snapshot) : base,
        ],
        "The VM was not created.",
      );
      try {
        if (snapshot) {
          await must(
            copyData(
              base,
              ["--volumes-from", vmRef, "--volume", `${snapshotVolume(snapshot)}:/from:ro`],
              "/from/.",
              `${DOCKER_DATA}/`,
            ),
            "The snapshot was not copied.",
          );
        }
        await must(["start", vmRef], "The VM did not start.");
        await waitDocker(vmRef);
        return { vmRef };
      } catch (error) {
        await provider.deleteVm(vmRef).catch((failure: unknown) => {
          logger.warn({ vm_ref: vmRef, err: failure }, "vm not deleted");
        });
        throw error;
      }
    },

    async exec(vmRef, request) {
      checkVmRef(vmRef);
      const timeoutS = Math.max(Math.ceil(request.timeoutS), 1);
      const startedAt = Date.now();
      const ran = await docker(
        [
          "exec",
          ...(request.stdin === undefined ? [] : ["-i"]),
          vmRef,
          "timeout",
          "-k",
          String(KILL_AFTER_S),
          String(timeoutS),
          "bash",
          "-c",
          request.command,
        ],
        { stdin: request.stdin, timeoutMs: (timeoutS + KILL_AFTER_S + EXEC_SLACK_S) * 1000 },
      );
      const late = Date.now() - startedAt >= timeoutS * 1000;
      if (ran.timedOut || (ran.exitCode !== null && TIMED_OUT_CODES.has(ran.exitCode) && late)) {
        return { exitCode: null, stdout: ran.stdout, stderr: ran.stderr, timedOut: true };
      }
      await refuseWhenGone(vmRef, ran);
      return result(ran);
    },

    async writeFile(vmRef, request) {
      checkVmRef(vmRef);
      const { path } = request;
      if (!FILE_PATH.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
        throw new ProviderRefused("A file goes under /tmp or /home/user, with a plain path.", 400);
      }
      const written = await docker(["exec", "-i", vmRef, "sh", "-c", WRITE_SCRIPT, "sh", path], {
        stdin: request.body,
        timeoutMs: STEP_TIMEOUT_MS,
      });
      if (written.exitCode === 0) return;
      await refuseWhenGone(vmRef, written);
      throw new ProviderUnavailable("The file was not written.");
    },

    async saveSnapshot(vmRef, name) {
      checkVmRef(vmRef);
      const key = keyOf(name);
      const base = await helperImage();
      await provider.deleteSnapshot(name);
      // The daemon of the VM stops first, so its data is whole.
      await must(["stop", "--time", "30", vmRef], "The VM did not stop.");
      try {
        const nameLabels = [`${SNAPSHOT_LABEL}=${name}`, `${DEPLOYMENT_LABEL}=${deploymentId}`];
        await must(
          [
            "commit",
            ...nameLabels.flatMap((label) => ["--change", `LABEL ${label}`]),
            vmRef,
            snapshotImage(key),
          ],
          "The snapshot was not saved.",
        );
        await must(
          [
            "volume",
            "create",
            ...nameLabels.flatMap((label) => ["--label", label]),
            snapshotVolume(key),
          ],
          "The snapshot was not saved.",
        );
        await must(
          copyData(
            base,
            ["--volumes-from", vmRef, "--volume", `${snapshotVolume(key)}:/to`],
            `${DOCKER_DATA}/.`,
            "/to/",
          ),
          "The snapshot was not saved.",
        );
      } catch (error) {
        await provider.deleteSnapshot(name).catch(() => undefined);
        throw error;
      } finally {
        await must(["start", vmRef], "The VM did not start again.")
          .then(() => waitDocker(vmRef))
          .catch((error: unknown) => logger.warn({ vm_ref: vmRef, err: error }, "vm not started"));
      }
      return { snapshotRef: name };
    },

    async deleteVm(vmRef) {
      if (!VM_REF.test(vmRef)) return;
      const removed = await docker(["rm", "-f", "-v", vmRef], { timeoutMs: STEP_TIMEOUT_MS });
      if (removed.exitCode !== 0 && !GONE.test(removed.stderr)) {
        throw unavailable("The VM was not deleted.", removed);
      }
    },

    async deleteSnapshot(snapshotRef) {
      if (!SNAPSHOT_NAME.test(snapshotRef)) return;
      const key = keyOf(snapshotRef);
      const image = await docker(["image", "rm", "-f", snapshotImage(key)]);
      if (image.exitCode !== 0 && !/No such image/.test(image.stderr)) {
        throw unavailable("The snapshot was not deleted.", image);
      }
      const volume = await docker(["volume", "rm", "-f", snapshotVolume(key)]);
      if (volume.exitCode !== 0) throw unavailable("The snapshot was not deleted.", volume);
    },

    async vmStatus(vmRef) {
      if (!VM_REF.test(vmRef)) return { state: "gone" };
      const found = await docker([
        "container",
        "inspect",
        "--format",
        `{{.State.Status}} {{index .Config.Labels "${DEPLOYMENT_LABEL}"}}`,
        vmRef,
      ]);
      if (found.exitCode !== 0) {
        if (GONE.test(found.stderr)) return { state: "gone" };
        throw unavailable("The VM state was not read.", found);
      }
      const [status = "", deployment] = found.stdout.trim().split(" ");
      return { state: deployment === deploymentId ? stateOf(status) : "gone" };
    },

    async listVms(labels) {
      const filters = Object.entries({
        ...labels,
        [VM_LABEL]: "1",
        [DEPLOYMENT_LABEL]: deploymentId,
      }).flatMap(([key, value]) => ["--filter", `label=${key}=${value}`]);
      const listed = await must(
        ["ps", "-a", "--no-trunc", "--format", "{{.Names}}", ...filters],
        "The VMs were not listed.",
      );
      const names = listed.stdout.split("\n").filter((name) => VM_REF.test(name));
      if (names.length === 0) return [];
      // A VM deleted since the list is left out: inspect still prints the others.
      const inspected = await docker(["container", "inspect", ...names]);
      return parseInspect(inspected.stdout).map((vm) => ({
        vmRef: vm.Name.replace(/^\//, ""),
        labels: vm.Config.Labels ?? {},
        createdAt: new Date(vm.Created),
      }));
    },
  };

  /** The image of a VM, built on the first call when the daemon does not have it. */
  function helperImage(): Promise<string> {
    helper ??= (async () => {
      const known = await docker(["image", "inspect", "--format", "{{.Id}}", LOCAL_VM_IMAGE]);
      if (known.exitCode === 0) return LOCAL_VM_IMAGE;
      logger.info({ image: LOCAL_VM_IMAGE }, "building the local VM image");
      await must(
        ["build", "--quiet", "--tag", LOCAL_VM_IMAGE, "-"],
        "The VM image was not built.",
        {
          stdin: DOCKERFILE,
          timeoutMs: BUILD_TIMEOUT_MS,
        },
      );
      return LOCAL_VM_IMAGE;
    })();
    helper.catch(() => {
      helper = undefined;
    });
    return helper;
  }

  /** The key of a known snapshot of this deployment. An unknown one is refused. */
  async function snapshotKey(name: string): Promise<string> {
    if (!SNAPSHOT_NAME.test(name)) throw new ProviderRefused("There is no such snapshot.", 404);
    const key = keyOf(name);
    const found = await docker([
      "image",
      "inspect",
      "--format",
      `{{index .Config.Labels "${SNAPSHOT_LABEL}"}}`,
      snapshotImage(key),
    ]);
    if (found.exitCode !== 0 || found.stdout.trim() !== name) {
      throw new ProviderRefused("There is no such snapshot.", 404);
    }
    return key;
  }

  /** Waits until the daemon of the VM answers. */
  async function waitDocker(vmRef: string): Promise<void> {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const info = await docker(["exec", vmRef, "docker", "info", "--format", "{{.ID}}"], {
        timeoutMs: 30_000,
      });
      if (info.exitCode === 0) return;
      if (GONE.test(info.stderr) || Date.now() > deadline) {
        throw new ProviderUnavailable("Docker did not start in the sandbox.");
      }
      await sleep(READY_POLL_MS);
    }
  }

  /** Deletes the VMs of this deployment whose TTL is over. A failure is only logged. */
  async function deleteExpired(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const listed = await docker([
      "ps",
      "-a",
      "--format",
      `{{.Names}} {{.Label "${EXPIRES_LABEL}"}}`,
      "--filter",
      `label=${VM_LABEL}=1`,
      "--filter",
      `label=${DEPLOYMENT_LABEL}=${deploymentId}`,
    ]);
    for (const line of listed.stdout.split("\n")) {
      const [vmRef = "", expiresAt] = line.trim().split(" ");
      if (!VM_REF.test(vmRef) || !(Number(expiresAt) < now)) continue;
      await provider.deleteVm(vmRef).catch((error: unknown) => {
        logger.warn({ vm_ref: vmRef, err: error }, "expired vm not deleted");
      });
    }
  }

  /** A call that must end with 0. Another end is {@link ProviderUnavailable}. */
  async function must(
    args: readonly string[],
    message: string,
    callOptions: DockerCallOptions = { timeoutMs: STEP_TIMEOUT_MS },
  ): Promise<DockerCall> {
    const done = await docker(args, callOptions);
    if (done.exitCode !== 0) throw unavailable(message, done);
    return done;
  }

  /** A command that failed because its VM is not there is refused, as the service refuses it. */
  async function refuseWhenGone(vmRef: string, ran: DockerCall): Promise<void> {
    if (ran.exitCode === 0 || ran.stdout !== "" || !GONE.test(ran.stderr)) return;
    if ((await provider.vmStatus(vmRef)).state !== "running") {
      throw new ProviderRefused("The VM is not there.", 404);
    }
  }

  return provider;
}

/** The {@link DockerCli} of the `docker` binary. No shell runs: the arguments go as they are. */
export const dockerCli: DockerCli = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const { stdin, timeoutMs } = options;
    const child = spawn("docker", [...args], {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProviderUnavailable("Docker is not available on this machine.", { cause: error }));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : exitCode,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        timedOut,
      });
    });
    if (child.stdin && stdin !== undefined) {
      // The command can end before it reads all of stdin; its exit code tells.
      child.stdin.on("error", () => undefined);
      const body = typeof stdin === "string" || stdin instanceof Uint8Array ? [stdin] : stdin;
      pipeline(Readable.from(body), child.stdin).catch(() => undefined);
    }
  });

function vmLabels(request: StartVmRequest, deploymentId: string): Record<string, string> {
  const ttlS = Math.max(1, Math.ceil(request.ttlS));
  const labels = {
    ...request.labels,
    "ratel-project": request.projectId,
    "ratel-purpose": request.purpose,
    [DEPLOYMENT_LABEL]: deploymentId,
    [VM_LABEL]: "1",
    [EXPIRES_LABEL]: String(Math.floor(Date.now() / 1000) + ttlS),
  };
  for (const key of Object.keys(labels)) {
    if (!LABEL_KEY.test(key)) throw new ProviderRefused(`The label ${key} is not valid.`, 400);
  }
  return labels;
}

/** The arguments of a one-time container of the VM image that copies Docker data. */
function copyData(image: string, mounts: readonly string[], from: string, to: string): string[] {
  return ["run", "--rm", ...mounts, "--entrypoint", "cp", image, "-a", from, to];
}

function checkVmRef(vmRef: string): void {
  if (!VM_REF.test(vmRef)) throw new ProviderRefused("The VM is not there.", 404);
}

/** The key of a snapshot: a hash of the deployment and the name. */
function snapshotKeyOf(deploymentId: string, name: string): string {
  if (!SNAPSHOT_NAME.test(name)) throw new ProviderRefused("The snapshot name is not valid.", 400);
  return createHash("sha256").update(`${deploymentId}\0${name}`).digest("hex").slice(0, 24);
}

function snapshotImage(key: string): string {
  return `${SNAPSHOT_IMAGE}:${key}`;
}

function snapshotVolume(key: string): string {
  return `${SNAPSHOT_IMAGE}-${key}`;
}

function stateOf(status: string): VmState {
  if (status === "running") return "running";
  if (status === "created" || status === "restarting") return "starting";
  return "stopped";
}

function result(ran: DockerCall): ExecResult {
  return { exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr, timedOut: false };
}

/** The failure of a Docker call. The log keeps the end of its stderr, never its stdin. */
function unavailable(message: string, call: DockerCall): ProviderUnavailable {
  logger.warn({ exit_code: call.exitCode, stderr: call.stderr.slice(-500) }, message);
  return new ProviderUnavailable(message);
}

type Inspected = { Name: string; Created: string; Config: { Labels?: Record<string, string> } };

function parseInspect(stdout: string): Inspected[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? (parsed as Inspected[]) : [];
  } catch {
    return [];
  }
}
