import { randomBytes, randomUUID } from "node:crypto";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import type { UsageLimitsPort, UsageRefusal } from "@/lib/contracts/usage-limits";
import { hashApiKey } from "@/lib/platform/api-keys";
import { getLogger } from "@/lib/platform/logger";
import type { SealedSecretsKey } from "@/lib/platform/sealed-secrets";
import { storable } from "@/lib/platform/storable";
import { secretNamesOf } from "./domain/config";
import {
  encodeRunInput,
  MAX_ENCODED_INPUT_BYTES,
  type RunInput,
  type SandboxRun,
  type ToolFixture,
} from "./domain/run";
import { imageTag, NOT_CONFIGURED_REASON } from "./image-build-job";
import type { RunStore } from "./ports/run-store";
import type { SandboxProvider } from "./ports/sandbox-provider";
import type { SecretStore } from "./ports/secret-store";
import type { VersionStore } from "./ports/version-store";
import { envFile, openSecretValues } from "./secret-values";

/** Starts runs and reads them. A run has one new instance. */
export type RunDeps = {
  runs: RunStore;
  versions: Pick<VersionStore, "get">;
  secrets: Pick<SecretStore, "readSealed">;
  provider: SandboxProvider | null;
  limits: UsageLimitsPort;
  sealingKey: () => SealedSecretsKey;
  /** The address at which an instance reaches this deployment. */
  callbackUrl: () => string;
  now: () => Date;
};

export type StartRunOptions = {
  projectId: string;
  organizationId: string;
  /** Who or what starts it. */
  requestedBy: string;
  params?: Record<string, unknown>;
  fixtures?: ToolFixture[];
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
  | "input_too_large";

/** The provider ends an instance a little after the run's own timeout, if the sweep does not. */
const INSTANCE_GRACE_S = 60;
const START_REASON = "The instance did not start. Run it again.";
const ENV_PATH = "/tmp/run.env";
const CONTAINER_START_S = 120;

const logger = getLogger("sandboxes/runs");

export async function startRun(
  versionId: string,
  input: unknown,
  options: StartRunOptions,
  deps: RunDeps,
): Promise<StartRunResult> {
  const { projectId, organizationId, requestedBy, params = {}, fixtures = [] } = options;
  const subject = { organizationId, projectId };
  const version = await deps.versions.get(projectId, versionId);
  if (!version) return refused("not_found", "There is no such version.");
  if (version.status !== "ready" || !version.imageRef) {
    return refused("not_ready", `The version is ${version.status}. Run a version that is ready.`);
  }
  if (!deps.provider) return refused("not_configured", NOT_CONFIGURED_REASON);

  const runId = randomUUID();
  const runInput: RunInput = storable({
    v: 1 as const,
    runId,
    input: input ?? null,
    params,
    toolPolicy: { sideEffects: "fake" as const },
    fixtures,
  });
  const encoded = encodeRunInput(runInput);
  if (encoded.length > MAX_ENCODED_INPUT_BYTES) {
    return refused("input_too_large", "The input, the params and the fixtures are too large.");
  }
  const secrets = await openSecretValues(projectId, secretNamesOf(version.config), deps);
  if (!secrets.ok) return secrets;

  const callbackUrl = deps.callbackUrl();
  const token = `rtl_run_${randomBytes(32).toString("base64url")}`;
  const timeoutS = await deps.limits.limit(subject, "sandbox_run_seconds");
  const created = await deps.runs.create(
    {
      id: runId,
      projectId,
      versionId,
      runInput,
      tokenHash: hashApiKey(token),
      timeoutS,
      requestedBy,
    },
    async ({ instances, today }) => {
      const concurrent = await deps.limits.check(subject, "sandbox_concurrent_instances", {
        current: instances,
      });
      if (!concurrent.ok) return concurrent;
      return deps.limits.check(subject, "sandbox_runs_per_day", { current: today });
    },
  );
  if (!created.ok) return { reason: "limit_reached", ...created };

  await launch(created.run, version.imageRef, deps.provider, deps, {
    ...secrets.values,
    RATEL_URL: callbackUrl,
    RATEL_RUN_TOKEN: token,
    RATEL_RUN_INPUT: encoded,
    RATEL_SECRET_NAMES: Object.keys(secrets.values).join(","),
  });
  await recordUsage(created.run.id, subject, deps);
  return { ok: true, run: (await deps.runs.get(projectId, runId)) ?? created.run };
}

export async function getRun(
  projectId: string,
  runId: string,
  deps: Pick<RunDeps, "runs">,
): Promise<SandboxRun | null> {
  return deps.runs.get(projectId, runId);
}

/** Records the usage of a started run, one time. The sweep tries again after a failure. */
export async function recordUsage(
  runId: string,
  subject: { organizationId: string; projectId: string },
  deps: Pick<RunDeps, "runs" | "limits" | "now">,
): Promise<void> {
  const run = await deps.runs.get(subject.projectId, runId);
  if (!run?.instanceRef) return;
  try {
    await deps.limits.record(subject, { kind: "sandbox_run", reference: runId });
    await deps.runs.markUsageRecorded(runId, deps.now());
  } catch (error) {
    logger.error(
      { project_id: subject.projectId, run_id: runId, err: error },
      "usage not recorded",
    );
  }
}

/** Stops the instance of a run. A failure leaves it to the sweep. */
export async function stopInstanceOf(
  run: Pick<SandboxRun, "id" | "projectId" | "instanceRef">,
  deps: Pick<RunDeps, "runs" | "provider" | "now">,
): Promise<boolean> {
  const { provider } = deps;
  const { instanceRef } = run;
  if (!instanceRef || !provider) return false;
  try {
    await withFeatureSpan("sandboxes", "stop_instance", () => provider.deleteVm(instanceRef), {
      attributes: { "project.id": run.projectId, "sandbox.run_id": run.id },
    });
    await deps.runs.markInstanceStopped(run.id, deps.now());
    return true;
  } catch (error) {
    logger.error({ project_id: run.projectId, run_id: run.id, err: error }, "instance not stopped");
    return false;
  }
}

async function launch(
  run: SandboxRun,
  imageRef: string,
  provider: SandboxProvider,
  deps: RunDeps,
  env: Record<string, string>,
): Promise<void> {
  const { id, projectId, timeoutS } = run;
  const attributes = { "project.id": projectId, "sandbox.run_id": id };
  let instanceRef: string;
  try {
    instanceRef = await withFeatureSpan(
      "sandboxes",
      "start_instance",
      () => startContainer(run, imageRef, provider, env, timeoutS + INSTANCE_GRACE_S),
      { attributes },
    );
  } catch (error) {
    logger.error({ project_id: projectId, run_id: id, err: error }, "instance not started");
    await deps.runs.finish(id, { status: "infra_error", reason: START_REASON }, deps.now());
    return;
  }
  let status: SandboxRun["status"] | null;
  try {
    status = await deps.runs.markStarted({ id, projectId }, instanceRef, deps.now());
  } catch (error) {
    // Nothing else knows this instance.
    await stopInstanceOf({ id, projectId, instanceRef }, deps);
    throw error;
  }
  logger.info({ project_id: projectId, run_id: id }, "sandbox run started");
  if (status !== "running") await stopInstanceOf({ id, projectId, instanceRef }, deps);
}

/**
 * Starts a run VM from the snapshot of the version and the agent's container in it. The VM is the
 * instance of the run. The variables go in a file, never on a command line: the service keeps
 * command lines. A VM whose container does not start is deleted.
 */
async function startContainer(
  run: SandboxRun,
  imageRef: string,
  provider: SandboxProvider,
  env: Record<string, string>,
  ttlS: number,
): Promise<string> {
  const { vmRef } = await provider.startVm({
    projectId: run.projectId,
    purpose: "run",
    fromSnapshot: imageRef,
    ttlS,
    labels: { "ratel-run": run.id },
    // Outbound is open: the agent calls its model and posts its result to RATEL_URL. No caller
    // needs to reach the VM, so inbound is closed. The variables file is small, so it goes
    // inline: an upload URL does not work on a closed VM.
    network: { inbound: "closed", outbound: { mode: "open" } },
    keepSnapshots: false,
  });
  try {
    const body = Buffer.from(envFile(env));
    await provider.writeFile(vmRef, { path: ENV_PATH, body, size: body.length });
    const started = await provider.exec(vmRef, {
      command: `docker run -d --env-file ${ENV_PATH} ${imageTag(run.versionId)}; code=$?; rm -f ${ENV_PATH}; exit $code`,
      timeoutS: CONTAINER_START_S,
    });
    if (started.exitCode !== 0) {
      throw new Error(`the container did not start (exit code ${started.exitCode})`);
    }
    return vmRef;
  } catch (error) {
    await provider.deleteVm(vmRef).catch((failure: unknown) => {
      // The TTL of the VM still ends it.
      logger.warn({ project_id: run.projectId, run_id: run.id, err: failure }, "vm not deleted");
    });
    throw error;
  }
}

function refused(reason: RefusalReason, message: string) {
  return { ok: false as const, reason, message };
}
