import type { RatelYaml } from "./domain/config";
import type {
  ExecRequest,
  ExecResult,
  SandboxProvider,
  StartVmRequest,
  WriteFileRequest,
} from "./ports/sandbox-provider";

/**
 * The handle of one VM for the code that uses it, the same for each provider. It keeps one rule: a
 * VM that got a secret is never saved as a snapshot. A snapshot keeps the disk, and a removal of
 * a container, a volume or a file does not remove each copy of a value. A secret goes into a VM
 * only through {@link VmSession.writeSecretFile}, which marks the VM before the write. After the
 * mark, {@link VmSession.saveSnapshot} throws {@link SnapshotRefused} and the provider gets no call.
 * A VM that this session did not start has an unknown past, so it is marked from the start.
 */
export type VmSession = {
  readonly vmRef: string;
  /** True while no secret went into the VM. */
  readonly secretFree: boolean;
  /** A command must not hold a secret value: the service keeps command lines. */
  exec(request: ExecRequest): Promise<ExecResult>;
  /** Writes a file that holds no secret value. */
  writeFile(request: WriteFileRequest): Promise<void>;
  /** Writes a file that holds secret values. The VM holds a secret from now on. */
  writeSecretFile(request: WriteFileRequest): Promise<void>;
  /** Saves the VM as a snapshot. It throws {@link SnapshotRefused} after a secret. */
  saveSnapshot(name: string): Promise<{ snapshotRef: string }>;
  delete(): Promise<void>;
};

/** A snapshot of a VM that got a secret, or of a VM with an unknown past. */
export class SnapshotRefused extends Error {
  constructor(vmRef: string) {
    super(`The VM ${vmRef} got a secret, so no snapshot of it is saved.`);
    this.name = "SnapshotRefused";
  }
}

/** Starts a VM. It holds no secret: a snapshot holds none. */
export async function startVmSession(
  provider: SandboxProvider,
  request: StartVmRequest,
): Promise<VmSession> {
  const { vmRef } = await provider.startVm(request);
  return session(provider, vmRef, true);
}

/** The session of a VM that another process or call started, e.g. a warm run VM. */
export function attachVmSession(provider: SandboxProvider, vmRef: string): VmSession {
  return session(provider, vmRef, false);
}

/**
 * The network of a VM that runs an agent with its secrets: no inbound, and outbound only to the
 * domains of ratel.yaml and this deployment, so the agent can send its traces. An address that is
 * not a domain name (an IP, localhost) is left out.
 */
export function agentVmNetwork(config: RatelYaml, callbackUrl: string): StartVmRequest["network"] {
  const allow = [...(config.network?.allow ?? [])];
  const host = URL.canParse(callbackUrl) ? new URL(callbackUrl).hostname : "";
  const isDomain = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host);
  if (isDomain && !allow.includes(host)) allow.push(host);
  return {
    inbound: "closed",
    outbound: allow.length > 0 ? { mode: "allow", allow } : { mode: "deny" },
  };
}

function session(provider: SandboxProvider, vmRef: string, secretFree: boolean): VmSession {
  let free = secretFree;
  return {
    vmRef,
    get secretFree() {
      return free;
    },
    exec: (request) => provider.exec(vmRef, request),
    writeFile: (request) => provider.writeFile(vmRef, request),
    writeSecretFile(request) {
      // Before the write: a write that fails can still leave a part of the file.
      free = false;
      return provider.writeFile(vmRef, request);
    },
    async saveSnapshot(name) {
      if (!free) throw new SnapshotRefused(vmRef);
      return provider.saveSnapshot(vmRef, name);
    },
    delete: () => provider.deleteVm(vmRef),
  };
}
