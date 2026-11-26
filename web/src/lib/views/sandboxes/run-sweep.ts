import { getLogger } from "@/lib/platform/logger";
import type { OpenRun } from "./ports/run-store";
import { VM_START_TIMEOUT_MS } from "./ports/sandbox-provider";
import { deleteVm, type RunDeps, recordUsage } from "./runs";

/**
 * The drain step of runs: it ends a run that its process left (no start, past its timeout, or its
 * VM is gone), records usage that was not recorded, deletes the VMs that are idle, and deletes each
 * run VM at the provider that the database does not know (a crash left it).
 */
export type SweepDeps = Pick<RunDeps, "runs" | "vms" | "provider" | "limits" | "now"> & {
  organizationIdOf: (projectId: string) => Promise<string | null>;
  /** A VM with no run for this time is deleted. */
  idleMs: number;
};

/**
 * A run that waits longer than this for its VM was left by a process that ended: a VM start ends
 * in {@link VM_START_TIMEOUT_MS}, and the rest is for the calls around it.
 */
export const START_STOPPED_MS = VM_START_TIMEOUT_MS + 3 * 60_000;
/** The time that a run needs beyond its own timeout: the health wait and the Docker steps. */
const RUN_GRACE_MS = 3 * 60_000;
const LIMIT = 500;
const PARALLEL = 10;

const TIMEOUT_REASON = "The run had no result before its timeout.";
const VM_GONE_REASON = "The VM of the run ended with no result. Run it again.";
const NOT_STARTED_REASON = "The run did not start. Run it again.";

const logger = getLogger("sandboxes/run-sweep");

export async function sweepRuns(
  deps: SweepDeps,
): Promise<{ endedRuns: number; deletedVms: number; sandboxRunErrors: number }> {
  const totals = { endedRuns: 0, deletedVms: 0, sandboxRunErrors: 0 };
  const open = await deps.runs.listOpen(LIMIT);
  await inParallel(open, async (run) => {
    try {
      const { ended, deleted } = await sweepRun(run, deps);
      if (ended) totals.endedRuns += 1;
      if (deleted) totals.deletedVms += 1;
    } catch (error) {
      totals.sandboxRunErrors += 1;
      logger.error({ project_id: run.projectId, run_id: run.id, err: error }, "run sweep failed");
    }
  });
  const now = deps.now();
  const idleSince = new Date(now.getTime() - deps.idleMs);
  const startingSince = new Date(now.getTime() - START_STOPPED_MS);
  const idle = await deps.vms.listIdle(idleSince, startingSince, LIMIT);
  await inParallel(idle, async (vm) => {
    try {
      // A run can claim the VM after the list: the VM goes only when it is still idle.
      if (!(await deps.vms.retireIdle(vm, idleSince, startingSince, now))) return;
    } catch (error) {
      logger.error({ project_id: vm.projectId, vm_id: vm.id, err: error }, "idle vm not retired");
      return;
    }
    // A failed delete leaves the VM to the sweep of unknown VMs: its row is deleted.
    if (await deleteVm(vm, vm.vmRef, deps)) totals.deletedVms += 1;
  });
  totals.deletedVms += await deleteUnknownVms(deps);
  return totals;
}

async function sweepRun(run: OpenRun, deps: SweepDeps) {
  const active = run.status === "queued" || run.status === "running";
  const over = active ? await endIfOver(run, deps) : { ended: false, deleted: false };
  // An active run records its usage when it ends: a later sweep reads its end.
  if (!active && run.startedAt && !run.usageRecordedAt) {
    const organizationId = await deps.organizationIdOf(run.projectId);
    if (organizationId) {
      await recordUsage(run, { organizationId, projectId: run.projectId }, deps);
    }
  }
  return over;
}

/** Ends a run that its process left. A result that comes at the same time wins. */
async function endIfOver(run: OpenRun, deps: SweepDeps) {
  const now = deps.now();
  if (run.status === "queued") {
    if (now.getTime() - run.createdAt.getTime() < START_STOPPED_MS) return nothing();
    const outcome = { status: "infra_error" as const, errorCode: "infra_error" };
    const ended = await deps.runs.finish(run.id, { ...outcome, message: NOT_STARTED_REASON }, now);
    return { ended, deleted: false };
  }
  const age = now.getTime() - (run.startedAt ?? run.createdAt).getTime();
  if (age >= run.timeoutS * 1000 + RUN_GRACE_MS) {
    const outcome = { status: "timed_out" as const, errorCode: "timeout" };
    const ended = await deps.runs.finish(run.id, { ...outcome, message: TIMEOUT_REASON }, now);
    // The process of the run is gone or stuck, so the state of its VM is not known.
    const vm = run.vmId ? await deps.vms.get(run.vmId) : null;
    const deleted =
      vm && vm.state !== "deleted" ? await deleteVm(vm, run.instanceRef, deps) : false;
    return { ended, deleted };
  }
  if (!deps.provider || !run.instanceRef) return nothing();
  const { state } = await deps.provider.vmStatus(run.instanceRef);
  if (state === "running" || state === "starting") return nothing();
  const outcome = { status: "infra_error" as const, errorCode: "infra_error" };
  const ended = await deps.runs.finish(run.id, { ...outcome, message: VM_GONE_REASON }, now);
  // The VM is not there any more: no new run must get it.
  if (run.vmId) await deps.vms.markDeleted(run.vmId, now);
  return { ended, deleted: false };
}

/**
 * The run VMs at the provider whose row is deleted or missing. Each VM carries the id of its row,
 * and the row is there before the VM starts.
 */
async function deleteUnknownVms(deps: SweepDeps): Promise<number> {
  const { provider } = deps;
  if (!provider) return 0;
  const found = await provider.listVms({ "ratel-purpose": "run" });
  const ids = found.flatMap(({ labels }) => (labels["ratel-vm"] ? [labels["ratel-vm"]] : []));
  const live = await deps.vms.live(ids);
  const unknown = found.filter(({ labels }) => !live.has(labels["ratel-vm"] ?? ""));
  let deleted = 0;
  await inParallel(unknown, async ({ vmRef }) => {
    try {
      await provider.deleteVm(vmRef);
      deleted += 1;
    } catch (error) {
      logger.error({ err: error }, "unknown vm not deleted");
    }
  });
  if (unknown.length > 0) logger.warn({ count: unknown.length }, "unknown run vms found");
  return deleted;
}

function nothing() {
  return { ended: false, deleted: false };
}

async function inParallel<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const lane = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await work(item);
  };
  await Promise.all(Array.from({ length: PARALLEL }, lane));
}
