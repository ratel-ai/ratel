import { randomBytes, randomUUID } from "node:crypto";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import type { UsageLimitsPort, UsageRefusal, UsageSubject } from "@/lib/contracts/usage-limits";
import { hashApiKey } from "@/lib/platform/api-keys";
import { getLogger } from "@/lib/platform/logger";
import type { SealedSecretsKey } from "@/lib/platform/sealed-secrets";
import { storable } from "@/lib/platform/storable";
import { type ContainerRun, DEFAULT_TIMEOUT_S, runContainer } from "./container-run";
import { secretNamesOf } from "./domain/config";
import {
  buildRunRequest,
  MAX_REQUEST_BYTES,
  type RunRequest,
  refusedChoice,
  type SandboxRun,
  type ToolChoice,
  type ToolFixture,
} from "./domain/run";
import type { SandboxVersion } from "./domain/version";
import { imageTag, NOT_CONFIGURED_REASON } from "./image-build-job";
import type { RunOutcome, RunStore } from "./ports/run-store";
import {
  accountRefusedReason,
  ProviderAtCapacity,
  ProviderRateLimited,
  ProviderUnavailable,
  type SandboxProvider,
} from "./ports/sandbox-provider";
import type { SecretStore } from "./ports/secret-store";
import type { VersionStore } from "./ports/version-store";
import type { RunVm, VmStore } from "./ports/vm-store";
import { openSecretValues } from "./secret-values";
import { agentVmNetwork, attachVmSession, startVmSession } from "./vm-session";
import { recordVmStart, vmStartCheck } from "./vm-starts";

/**
 * Starts runs and reads them. A run gets a warm VM of its version, or a new one, and a new
 * container in it. The start answers at once; the VM, the container and the request run after it
 * (`background`).
 */
export type RunDeps = {
  runs: RunStore;
  vms: VmStore;
  versions: Pick<VersionStore, "get">;
  secrets: Pick<SecretStore, "readSealed">;
  provider: SandboxProvider | null;
  limits: UsageLimitsPort;
  sealingKey: () => SealedSecretsKey;
  /** The address at which a container reaches this deployment. */
  callbackUrl: () => string;
  now: () => Date;
  /** Runs the long part of a run after the start returns. It must not throw. */
  background: (work: () => Promise<void>) => void;
};

export type StartRunOptions = {
  projectId: string;
  organizationId: string;
  /** Who or what starts it. */
  requestedBy: string;
  params?: Record<string, unknown>;
  /** The mode of each tool. A tool has its mode of ratel.yaml when it is not here. */
  tools?: ToolChoice;
  fixtures?: ToolFixture[];
  /**
   * Refuses params and tools that ratel.yaml does not declare, or of the wrong type. An eval does
   * not ask for it: its params also hold its earlier turns.
   */
  strict?: boolean;
};

export type StartRunResult =
  | { ok: true; run: SandboxRun }
  | { ok: false; reason: RefusalReason; message: string }
  | ({ ok: false; reason: "limit_reached" } & UsageRefusal);

type RefusalReason =
  | "not_found"
  | "not_ready"
  | "not_configured"
  | "missing_secrets"
  | "input_too_large"
  | "invalid";

/** A VM takes at most this many runs at the same time. */
export const MAX_RUNS_PER_VM = 4;
/** The provider deletes a run VM after this time, if the sweep does not. */
export const VM_TTL_S = 2 * 60 * 60;
/** A VM takes no new run in the last part of its life: the longest run must end before its TTL. */
const VM_CLAIM_MAX_AGE_S = VM_TTL_S - 40 * 60;

const logger = getLogger("sandboxes/runs");

export async function startRun(
  versionId: string,
  input: unknown,
  options: StartRunOptions,
  deps: RunDeps,
): Promise<StartRunResult> {
  const { projectId, organizationId, requestedBy, params = {}, tools = {} } = options;
  const subject = { organizationId, projectId };
  const version = await deps.versions.get(projectId, versionId);
  if (!version) return refused("not_found", "There is no such version.");
  if (version.status !== "ready" || !version.imageRef) {
    return refused("not_ready", notReadyMessage(version.status));
  }
  if (!deps.provider) return refused("not_configured", NOT_CONFIGURED_REASON);
  const wrong = options.strict ? refusedChoice(version.config, params, tools) : null;
  if (wrong) return refused("invalid", wrong);

  const runId = randomUUID();
  const traceId = randomBytes(16).toString("hex");
  const request: RunRequest = storable(
    buildRunRequest(version.config, {
      runId,
      input,
      params,
      tools,
      fixtures: options.fixtures ?? [],
      traceId,
    }),
  );
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) {
    return refused("input_too_large", "The input, the params and the fixtures are too large.");
  }
  const secrets = await openSecretValues(projectId, secretNamesOf(version.config), deps);
  if (!secrets.ok) return secrets;

  const token = `rtl_run_${randomBytes(32).toString("base64url")}`;
  const timeoutS = Math.min(
    version.config.run?.timeoutSeconds ?? DEFAULT_TIMEOUT_S,
    await deps.limits.limit(subject, "sandbox_run_seconds"),
  );
  const created = await deps.runs.create(
    {
      id: runId,
      projectId,
      versionId,
      request,
      tokenHash: hashApiKey(token),
      traceId,
      timeoutS,
      requestedBy,
    },
    async ({ active, today }) => {
      const concurrent = await deps.limits.check(subject, "sandbox_concurrent_instances", {
        current: active,
      });
      if (!concurrent.ok) return concurrent;
      return deps.limits.check(subject, "sandbox_runs_per_day", { current: today });
    },
  );
  if (!created.ok) {
    // The version was retired after the read above.
    if ("versionStatus" in created) {
      return refused("not_ready", notReadyMessage(created.versionStatus ?? "gone"));
    }
    return { reason: "limit_reached", ...created };
  }

  const now = deps.now();
  const claimed = await deps.vms.claim(
    {
      projectId,
      versionId,
      runId,
      maxRuns: MAX_RUNS_PER_VM,
      startedAfter: new Date(now.getTime() - VM_CLAIM_MAX_AGE_S * 1000),
      now,
    },
    vmStartCheck(deps.limits, subject),
  );
  if (!claimed.ok) {
    await deps.runs.discard(runId);
    return { reason: "limit_reached", ...claimed };
  }
  const { provider } = deps;
  const launch: Launch = {
    run: { ...created.run, vmId: claimed.vm.id },
    version,
    vm: claimed.vm,
    isNew: claimed.isNew,
    secrets: secrets.values,
    token,
    subject,
  };
  deps.background(() => executeRun(launch, provider, deps));
  return { ok: true, run: launch.run };
}

export async function getRun(
  projectId: string,
  runId: string,
  deps: Pick<RunDeps, "runs">,
): Promise<SandboxRun | null> {
  return deps.runs.get(projectId, runId);
}

/**
 * Records the usage of a run that started and ended, one time, with its VM seconds. The sweep
 * tries again after a failure.
 */
export async function recordUsage(
  run: RunTime,
  subject: UsageSubject,
  deps: Pick<RunDeps, "runs" | "limits" | "now">,
): Promise<void> {
  try {
    const seconds = runSeconds(run);
    await deps.limits.record(subject, { kind: "sandbox_run", reference: run.id, seconds });
    await deps.runs.markUsageRecorded(run.id, deps.now());
  } catch (error) {
    logger.error(
      { project_id: subject.projectId, run_id: run.id, err: error },
      "usage not recorded",
    );
  }
}

/** Deletes a run VM. A failure leaves it to the sweep, which finds it at the provider. */
export async function deleteVm(
  vm: Pick<RunVm, "id" | "projectId">,
  vmRef: string | null,
  deps: Pick<RunDeps, "vms" | "provider" | "now">,
): Promise<boolean> {
  try {
    const { provider } = deps;
    if (vmRef && provider) {
      await withFeatureSpan("sandboxes", "delete_vm", () => provider.deleteVm(vmRef), {
        attributes: { "project.id": vm.projectId, "sandbox.vm_id": vm.id },
      });
    }
    await deps.vms.markDeleted(vm.id, deps.now());
    return true;
  } catch (error) {
    logger.error({ project_id: vm.projectId, vm_id: vm.id, err: error }, "vm not deleted");
    return false;
  }
}

/** What the VM seconds of a run come from. */
type RunTime = Pick<SandboxRun, "id" | "durationMs" | "startedAt" | "finishedAt">;

type Launch = {
  run: SandboxRun;
  version: SandboxVersion;
  vm: RunVm;
  isNew: boolean;
  secrets: Record<string, string>;
  token: string;
  subject: UsageSubject;
};

/**
 * The long part of a run: the VM (a new one when the claim made it), a new container, the request
 * and the answer. A provider failure deletes the VM and ends the run `infra_error`, with the code
 * `provider_refused` when the provider refused the account (401, 402, 403). It never throws.
 */
async function executeRun(launch: Launch, provider: SandboxProvider, deps: RunDeps): Promise<void> {
  const { run, vm, subject } = launch;
  const attributes = { "project.id": run.projectId, "sandbox.run_id": run.id };
  let vmRef = vm.vmRef;
  try {
    if (launch.isNew) {
      vmRef = await withFeatureSpan(
        "sandboxes",
        "start_vm",
        () => startVm(launch, provider, deps),
        {
          attributes,
        },
      );
    }
    if (!vmRef) throw new Error("a ready VM has no reference");
    const startedAt = deps.now();
    const status = await deps.runs.markStarted(run.id, vmRef, startedAt);
    if (status !== "running") return;
    const ran = await withFeatureSpan(
      "sandboxes",
      "run_container",
      () => runIn(launch, vmRef ?? "", provider, deps),
      { attributes },
    );
    const finishedAt = deps.now();
    if (await deps.runs.finish(run.id, outcomeOf(ran), finishedAt)) {
      const time = { id: run.id, durationMs: ran.durationMs, startedAt, finishedAt };
      await recordUsage(time, subject, deps);
    }
    logger.info(
      { ...logged(run), outcome: ran.answer.ok ? "completed" : ran.answer.error.code },
      "sandbox run finished",
    );
    // A container or a file that stays could reach the next run.
    if (!ran.cleaned) await deleteVm(vm, vmRef, deps);
  } catch (error) {
    logger.error({ ...logged(run), err: error }, "sandbox run broke");
    await deleteVm(vm, vmRef, deps);
    const errorCode = accountRefusedReason(error) ? "provider_refused" : "infra_error";
    await deps.runs
      .finish(run.id, { status: "infra_error", errorCode, message: infraReason(error) }, deps.now())
      .catch((failure: unknown) => logger.error({ ...logged(run), err: failure }, "run not ended"));
  } finally {
    await deps.vms
      .touch(vm.id, deps.now())
      .catch((failure: unknown) => logger.warn({ ...logged(run), err: failure }, "vm not touched"));
  }
}

/** Starts the VM of a claim from the snapshot of the version, and counts its start. */
async function startVm(launch: Launch, provider: SandboxProvider, deps: RunDeps): Promise<string> {
  const { run, version, vm, subject } = launch;
  let vmRef: string | null = null;
  try {
    ({ vmRef } = await startVmSession(provider, {
      projectId: run.projectId,
      purpose: "run",
      fromSnapshot: version.imageRef ?? "",
      ttlS: VM_TTL_S,
      labels: {
        "ratel-project": run.projectId,
        "ratel-version": run.versionId,
        "ratel-purpose": "run",
        "ratel-vm": vm.id,
      },
      // The runs go through `exec` and curl in the VM, so no caller reaches the VM.
      network: agentVmNetwork(version.config, deps.callbackUrl()),
      keepSnapshots: false,
    }));
    await deps.vms.markReady(vm.id, vmRef, deps.now());
  } catch (error) {
    await deleteVm(vm, vmRef, deps);
    throw error;
  }
  await recordVmStart(deps.limits, subject, vm.id, "run");
  return vmRef;
}

/** The run in a new container. The run token is only the trace key of the agent. */
function runIn(
  launch: Launch,
  vmRef: string,
  provider: SandboxProvider,
  deps: RunDeps,
): Promise<ContainerRun> {
  const { run, version, token } = launch;
  return runContainer(attachVmSession(provider, vmRef), {
    name: `run-${run.id}`,
    filePrefix: `/tmp/ratel-run-${run.id}-`,
    config: version.config,
    tag: imageTag(version.id),
    secrets: launch.secrets,
    env: {
      RATEL_API_KEY: token,
      RATEL_BASE_URL: `${deps.callbackUrl().replace(/\/+$/, "")}/api/v1`,
    },
    hidden: [token],
    request: run.request,
    timeoutS: run.timeoutS,
  });
}

/** The time of the container when it is known, else the time from the start to the end. */
function runSeconds({ durationMs, startedAt, finishedAt }: RunTime): number {
  const ms = durationMs ?? (finishedAt?.getTime() ?? 0) - (startedAt?.getTime() ?? 0);
  return Math.max(0, Math.ceil(ms / 1000));
}

function outcomeOf({ answer, logs, durationMs }: ContainerRun): RunOutcome {
  if (answer.ok) return { status: "completed", response: answer.response, logs, durationMs };
  const { code, message } = answer.error;
  const status = code === "timeout" ? "timed_out" : "failed";
  return { status, errorCode: code, message, logs, durationMs };
}

/** The reason of an infrastructure failure for the developer. It never names the provider. */
function infraReason(error: unknown): string {
  if (error instanceof ProviderRateLimited) {
    const wait = error.retryAfterS === null ? "a minute" : `${Math.ceil(error.retryAfterS)} s`;
    return `The sandbox service has too many requests now. Run again in ${wait}.`;
  }
  if (error instanceof ProviderAtCapacity) {
    return "Ratel sandbox runs as many machines as it can now. Run again in a few minutes.";
  }
  if (error instanceof ProviderUnavailable) {
    return "The sandbox service did not answer. Run again later.";
  }
  return accountRefusedReason(error) ?? "The sandbox did not work. Run again.";
}

function logged(run: Pick<SandboxRun, "id" | "projectId">) {
  return { project_id: run.projectId, run_id: run.id };
}

/** Why a version that is not ready does not run, for the developer. */
function notReadyMessage(status: string): string {
  if (status === "retired") {
    return "The version is retired: its image was deleted, as only the newest versions of a sandbox keep theirs. Run a newer version, or push this code again.";
  }
  return `The version is ${status}. Run a version that is ready.`;
}

function refused(reason: RefusalReason, message: string) {
  return { ok: false as const, reason, message };
}
