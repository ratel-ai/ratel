import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLocalDockerProvider,
  type DockerCall,
  type DockerCli,
} from "../adapters/local-docker-provider";
import { snapshotName } from "../domain/snapshot-name";
import { ProviderRefused, type StartVmRequest } from "../ports/sandbox-provider";

/** User values with shell characters: each must stay one whole argv entry. */
const EVIL = `$(touch /tmp/pwned); \`id\` 'a' "b" | rm -rf / & echo`;
const START: StartVmRequest = {
  projectId: "p1",
  purpose: "run",
  ttlS: 600,
  labels: { "ratel-version": EVIL },
  network: { inbound: "closed", outbound: { mode: "deny" } },
  keepSnapshots: false,
};

type Call = { args: readonly string[]; stdin: string | null };

/** A Docker CLI that answers every call with success and records its argv and stdin. */
function spyDocker(answer: (args: readonly string[]) => Partial<DockerCall> = () => ({})) {
  const calls: Call[] = [];
  const docker: DockerCli = async (args, options = {}) => {
    calls.push({ args, stdin: options.stdin === undefined ? null : await textOf(options.stdin) });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...answer(args) };
  };
  return { calls, docker };
}

test("exec gives the command to bash as one argv entry, with the timeout and stdin", async () => {
  const { calls, docker } = spyDocker();
  const provider = createLocalDockerProvider({ deploymentId: "dev", docker });
  const command = `echo ${EVIL}`;
  await provider.exec("ratel-vm-0123456789ab", { command, timeoutS: 30, stdin: EVIL });
  const call = calls.at(-1);
  assert.deepEqual(call?.args, [
    "exec",
    "-i",
    "ratel-vm-0123456789ab",
    "timeout",
    "-k",
    "5",
    "30",
    "bash",
    "-c",
    command,
  ]);
  assert.equal(call?.stdin, EVIL);
});

test("exec reports the exit code, and the timeout of a command that ran out of time", async () => {
  const { docker } = spyDocker(() => ({ exitCode: 124, stdout: "part", timedOut: true }));
  const provider = createLocalDockerProvider({ deploymentId: "dev", docker });
  const ran = await provider.exec("ratel-vm-0123456789ab", { command: "sleep 9", timeoutS: 1 });
  assert.deepEqual(ran, { exitCode: null, stdout: "part", stderr: "", timedOut: true });
  const quick = createLocalDockerProvider({
    deploymentId: "dev",
    docker: spyDocker(() => ({ exitCode: 3 })).docker,
  });
  const three = await quick.exec("ratel-vm-0123456789ab", { command: "exit 3", timeoutS: 30 });
  assert.deepEqual(three, { exitCode: 3, stdout: "", stderr: "", timedOut: false });
});

test("writeFile streams the body on stdin and passes the path as its own argv entry", async () => {
  const { calls, docker } = spyDocker();
  const provider = createLocalDockerProvider({ deploymentId: "dev", docker });
  const body = Buffer.from(`A=${EVIL}\n`);
  await provider.writeFile("ratel-vm-0123456789ab", { path: "/tmp/ratel-env", body, size: 3 });
  const call = calls.at(-1);
  assert.equal(call?.args.at(-1), "/tmp/ratel-env");
  assert.deepEqual(call?.args.slice(0, 5), ["exec", "-i", "ratel-vm-0123456789ab", "sh", "-c"]);
  assert.match(call?.args[5] ?? "", /umask 077/);
  assert.equal(call?.stdin, body.toString());
  assert.ok(calls.every(({ args }) => !args.some((arg) => arg !== EVIL && arg.includes("pwned"))));
});

test("writeFile refuses a path outside /tmp and /home/user, or with shell characters", async () => {
  const { calls, docker } = spyDocker();
  const provider = createLocalDockerProvider({ deploymentId: "dev", docker });
  const body = Buffer.from("x");
  for (const path of ["/etc/passwd", "/tmp/../etc/x", "/tmp/$(touch /tmp/pwned)", "/home/user"]) {
    await assert.rejects(
      provider.writeFile("ratel-vm-0123456789ab", { path, body, size: 1 }),
      ProviderRefused,
    );
  }
  assert.equal(calls.length, 0);
});

test("startVm passes each label as one argv entry and marks the VM of the deployment", async () => {
  const { calls, docker } = spyDocker((args) =>
    args[0] === "exec" ? { exitCode: 0 } : { stdout: "" },
  );
  const provider = createLocalDockerProvider({ deploymentId: "dev", docker });
  const { vmRef } = await provider.startVm(START);
  assert.match(vmRef, /^ratel-vm-[a-f0-9]{12}$/);
  const create = calls.find(({ args }) => args[0] === "create");
  assert.ok(create);
  const labels = create.args.flatMap((arg, i) => (create.args[i - 1] === "--label" ? [arg] : []));
  assert.ok(labels.includes(`ratel-version=${EVIL}`));
  assert.ok(labels.includes("ratel-deployment=dev"));
  assert.ok(labels.includes("ratel-local-vm=1"));
  assert.ok(labels.includes("ratel-purpose=run"));
  assert.ok(create.args.includes("--privileged"));
});

test("a VM does not start from a snapshot that is not there", async () => {
  const { docker } = spyDocker((args) =>
    args[0] === "image" && args.some((arg) => arg.startsWith("ratel-local-snap:"))
      ? { exitCode: 1, stderr: "Error: No such image" }
      : {},
  );
  const provider = createLocalDockerProvider({ deploymentId: "dev", docker });
  await assert.rejects(
    provider.startVm({ ...START, fromSnapshot: "rv-none" }),
    (error: unknown) => error instanceof ProviderRefused && error.status === 404,
  );
});

test("a snapshot name or a VM reference that is not plain never reaches Docker", async () => {
  const { calls, docker } = spyDocker();
  const provider = createLocalDockerProvider({ deploymentId: "dev", docker });
  await assert.rejects(provider.saveSnapshot("ratel-vm-0123456789ab", EVIL));
  await assert.rejects(provider.startVm({ ...START, fromSnapshot: EVIL }), ProviderRefused);
  await provider.deleteSnapshot(EVIL);
  await provider.deleteVm(EVIL);
  assert.deepEqual(await provider.vmStatus(EVIL), { state: "gone" });
  await assert.rejects(provider.exec(EVIL, { command: "true", timeoutS: 1 }), ProviderRefused);
  assert.ok(calls.every(({ args }) => !args.includes(EVIL)));
});

test("listVms asks only for the VMs of this deployment, each label one filter", async () => {
  const { calls, docker } = spyDocker();
  const provider = createLocalDockerProvider({ deploymentId: "dev", docker });
  assert.deepEqual(await provider.listVms({ "ratel-purpose": "run", odd: EVIL }), []);
  const ps = calls.find(({ args }) => args[0] === "ps");
  assert.ok(ps);
  const filters = ps.args.flatMap((arg, i) => (ps.args[i - 1] === "--filter" ? [arg] : []));
  assert.deepEqual(
    filters.sort(),
    [
      "label=ratel-deployment=dev",
      "label=ratel-local-vm=1",
      "label=ratel-purpose=run",
      `label=odd=${EVIL}`,
    ].sort(),
  );
});

test("listSnapshots lists only the snapshots of this deployment with the name of a version", async () => {
  const version = "0b6c1f0e-5d0a-4c55-9f4e-3d2b1a0f9e8d";
  const ours = snapshotName("dev", version);
  const names = [ours, snapshotName("dev-2", version), `rv-${version}`, "rc-contract", ""];
  const { calls, docker } = spyDocker((args) =>
    args[0] === "volume" ? { stdout: `${names.join("\n")}\n` } : {},
  );
  const provider = createLocalDockerProvider({ deploymentId: "dev", docker });
  assert.deepEqual(await provider.listSnapshots(), [{ snapshotRef: ours, versionId: version }]);
  const ls = calls.find(({ args }) => args[0] === "volume");
  assert.ok(ls);
  const filters = ls.args.flatMap((arg, i) => (ls.args[i - 1] === "--filter" ? [arg] : []));
  assert.deepEqual(filters.sort(), ["label=ratel-deployment=dev", "label=ratel-local-snapshot"]);
});

async function textOf(body: NonNullable<Parameters<DockerCli>[1]>["stdin"]): Promise<string> {
  if (body === undefined) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString();
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
