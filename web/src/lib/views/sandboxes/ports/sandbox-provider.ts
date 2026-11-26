/**
 * The service that runs virtual machines with Docker. A "prepare" VM loads an image and is saved
 * as a snapshot; a "run" VM starts from that snapshot and runs one agent. The developer never sees
 * which service it is, so no message of an error of this port names it. One provider serves one
 * deployment: it marks each VM that it starts as a VM of the deployment.
 */
export interface SandboxProvider {
  /**
   * Starts one VM and waits until it is ready (Docker answers). It ends in
   * {@link VM_START_TIMEOUT_MS} at most, plus the time of one call.
   */
  startVm(request: StartVmRequest): Promise<{ vmRef: string }>;
  /** Runs one shell command in the VM and waits for its end. */
  exec(vmRef: string, request: ExecRequest): Promise<ExecResult>;
  /** Writes a file of any size into the VM, under `/home/user` or `/tmp`. */
  writeFile(vmRef: string, request: WriteFileRequest): Promise<void>;
  /** Saves the disk of the VM as a named snapshot ("prepare") and waits until it is ready. */
  saveSnapshot(vmRef: string, name: string): Promise<{ snapshotRef: string }>;
  /** Deletes a VM. A VM that is not there is deleted. */
  deleteVm(vmRef: string): Promise<void>;
  /** Deletes a snapshot. A snapshot that is not there is deleted. */
  deleteSnapshot(snapshotRef: string): Promise<void>;
  vmStatus(vmRef: string): Promise<{ state: VmState }>;
  /** The VMs of this deployment that have all these labels. No VM of another deployment. */
  listVms(labels: Readonly<Record<string, string>>): Promise<VmInfo[]>;
}

/** The longest time of a VM start, the create, the ready wait and the Docker wait included. */
export const VM_START_TIMEOUT_MS = 12 * 60_000;

export type StartVmRequest = {
  projectId: string;
  purpose: "prepare" | "run";
  /** The snapshot to start from. With none, the VM starts from the base image. */
  fromSnapshot?: string;
  /** The service deletes the VM after this time, if Ratel does not. */
  ttlS: number;
  labels: Readonly<Record<string, string>>;
  network: {
    inbound: "open" | "closed";
    outbound: { mode: "open" } | { mode: "deny" } | { mode: "allow"; allow: readonly string[] };
  };
  /** False for run VMs: no snapshot of them is kept, so none can be saved. */
  keepSnapshots: boolean;
};

export type ExecRequest = {
  /** A shell command. It must not hold a secret value: the service keeps command lines. */
  command: string;
  /** The command ends at this time. A time longer than the service allows still holds. */
  timeoutS: number;
  stdin?: string;
};

export type ExecResult = {
  /** Null when the command did not end by itself. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type WriteFileRequest = {
  path: string;
  body: AsyncIterable<Uint8Array> | Uint8Array;
  /** The bytes of the body. */
  size: number;
};

export type VmState = "starting" | "running" | "stopped" | "gone";

export type VmInfo = { vmRef: string; labels: Record<string, string>; createdAt: Date };

/** Too many calls or starts. Try again after `retryAfterS` seconds, when known. */
export class ProviderRateLimited extends Error {
  constructor(
    message: string,
    readonly retryAfterS: number | null,
  ) {
    super(message);
    this.name = "ProviderRateLimited";
  }
}

/** The account runs as many VMs at once as it can. */
export class ProviderAtCapacity extends Error {
  constructor(message = "The sandbox service runs as many machines as the account allows.") {
    super(message);
    this.name = "ProviderAtCapacity";
  }
}

/** The service did not answer or did not work (a 5xx, a network error, a VM that did not start). */
export class ProviderUnavailable extends Error {
  constructor(
    message = "The sandbox service did not work. Try again later.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderUnavailable";
  }
}

/** The service refused the call (billing, permission, a bad request). Trying again does not help. */
export class ProviderRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProviderRefused";
  }
}

/** The version cannot build. The message is for the developer. */
export class BuildFailed extends Error {}
