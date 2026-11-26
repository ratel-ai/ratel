import { randomUUID } from "node:crypto";
import {
  type ExecRequest,
  type ExecResult,
  ProviderRefused,
  type SandboxProvider,
  type StartVmRequest,
  type VmState,
} from "../ports/sandbox-provider";
import { runFakeShell } from "./fake-shell";

export type FakeVm = {
  vmRef: string;
  request: StartVmRequest;
  labels: Record<string, string>;
  state: VmState;
  files: Map<string, Buffer>;
  createdAt: Date;
};

export type FakeProvider = SandboxProvider & {
  vms: Map<string, FakeVm>;
  snapshots: Map<string, Map<string, Buffer>>;
  starts: Array<StartVmRequest & { vmRef: string }>;
  /** Every call of `deleteVm`, in order. */
  deleted: string[];
  execs: Array<{ vmRef: string; command: string }>;
  writes: Array<{ vmRef: string; path: string; body: Buffer }>;
  /**
   * Answers a command, e.g. to script `docker load`, `docker run` or `curl`. Undefined falls back
   * to the default: `docker load` loads `agent:latest`, and the fake shell runs the rest.
   */
  onExec: (
    vm: FakeVm,
    request: ExecRequest,
  ) => ExecResult | undefined | Promise<ExecResult | undefined>;
  /** The VMs that run now. */
  readonly running: Set<string>;
  /** A VM stops by itself. */
  exit(vmRef: string): void;
  /** The text of the last write of a path in a VM. */
  fileOf(vmRef: string, path: string): string | undefined;
};

/**
 * An in-memory provider. It keeps the rules of the port that the contract test checks: each VM
 * carries the deployment label, and `listVms` lists only the VMs of the deployment.
 */
export function createFakeProvider({ deploymentId = "test-deployment" } = {}): FakeProvider {
  const live = (vmRef: string): FakeVm => {
    const vm = fake.vms.get(vmRef);
    if (!vm || vm.state !== "running") throw new ProviderRefused("The VM is not running.", 409);
    return vm;
  };
  const fake: FakeProvider = {
    vms: new Map(),
    snapshots: new Map(),
    starts: [],
    deleted: [],
    execs: [],
    writes: [],
    onExec: () => undefined,
    get running() {
      return new Set(
        [...fake.vms.values()].filter((vm) => vm.state === "running").map((vm) => vm.vmRef),
      );
    },
    exit(vmRef) {
      const vm = fake.vms.get(vmRef);
      if (vm) vm.state = "stopped";
    },
    fileOf(vmRef, path) {
      const found = fake.writes.findLast((write) => write.vmRef === vmRef && write.path === path);
      return found?.body.toString();
    },

    async startVm(request) {
      const from = request.fromSnapshot ? fake.snapshots.get(request.fromSnapshot) : undefined;
      if (request.fromSnapshot && !from)
        throw new ProviderRefused("There is no such snapshot.", 404);
      const vmRef = `vm-${randomUUID()}`;
      fake.starts.push({ ...request, vmRef });
      fake.vms.set(vmRef, {
        vmRef,
        request,
        labels: {
          ...request.labels,
          "ratel-project": request.projectId,
          "ratel-purpose": request.purpose,
          "ratel-deployment": deploymentId,
        },
        state: "running",
        files: new Map(from ?? []),
        createdAt: new Date(),
      });
      return { vmRef };
    },
    async exec(vmRef, request) {
      const vm = live(vmRef);
      fake.execs.push({ vmRef, command: request.command });
      const scripted = await fake.onExec(vm, request);
      if (scripted) return scripted;
      if (request.command.includes("docker load")) {
        return { exitCode: 0, stdout: "Loaded image: agent:latest\n", stderr: "", timedOut: false };
      }
      return runFakeShell(request.command, vm.files, request.timeoutS, request.stdin);
    },
    async writeFile(vmRef, { path, body }) {
      const vm = live(vmRef);
      const parts: Uint8Array[] = [];
      if (body instanceof Uint8Array) parts.push(body);
      else for await (const part of body) parts.push(part);
      const bytes = Buffer.concat(parts);
      vm.files.set(path, bytes);
      fake.writes.push({ vmRef, path, body: bytes });
    },
    async saveSnapshot(vmRef, name) {
      const vm = live(vmRef);
      if (!vm.request.keepSnapshots) throw new ProviderRefused("The VM keeps no snapshots.", 409);
      fake.snapshots.set(name, new Map(vm.files));
      return { snapshotRef: name };
    },
    async deleteVm(vmRef) {
      fake.deleted.push(vmRef);
      fake.vms.delete(vmRef);
    },
    async deleteSnapshot(snapshotRef) {
      fake.snapshots.delete(snapshotRef);
    },
    async vmStatus(vmRef) {
      return { state: fake.vms.get(vmRef)?.state ?? "gone" };
    },
    async listVms(labels) {
      const own = { ...labels, "ratel-deployment": deploymentId };
      return [...fake.vms.values()]
        .filter((vm) => Object.entries(own).every(([key, value]) => vm.labels[key] === value))
        .map((vm) => ({ vmRef: vm.vmRef, labels: { ...vm.labels }, createdAt: vm.createdAt }));
    },
  };
  return fake;
}
