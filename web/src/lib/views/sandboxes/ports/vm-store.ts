import type { UsageCheck, UsageRefusal } from "@/lib/contracts/usage-limits";

/**
 * The VM starts before a new one, by scope: the project and its organization this UTC day, and all
 * projects of this deployment (one provider account) in the last minute, the last hour and this
 * UTC day. Each start counts from its row, also when its VM did not start.
 */
export type VmStartCounts = {
  project: number;
  organization: number;
  accountMinute: number;
  accountHour: number;
  accountDay: number;
};

/** One VM of a version: a run VM, or the prepare or the smoke VM of a build. */
export type RunVm = {
  id: string;
  projectId: string;
  versionId: string;
  /** Null while the VM starts. */
  vmRef: string | null;
  state: "starting" | "ready" | "deleted";
  startedAt: Date;
  lastUsedAt: Date;
};

export type VmClaim = {
  projectId: string;
  versionId: string;
  /** The run that gets the VM. */
  runId: string;
  /** A VM takes at most this many active runs. */
  maxRuns: number;
  /** A VM that started before this time takes no new run: its end at the provider is near. */
  startedAfter: Date;
  now: Date;
};

/**
 * The VMs of the projects. Each run VM of a version takes a few runs at the same time while it is
 * warm. Each VM start of each purpose (prepare, smoke, run) has a row, and the rows are the VM
 * starts of the budgets of `vm-starts.ts`. A row counts from
 * its insert, also when its VM does not start: the budget counts attempts.
 */
export interface VmStore {
  /**
   * Gives the run a `ready` VM of its version that has room, else a new `starting` VM when `check`
   * passes. `check` gets the {@link VmStartCounts}. Two claims at the same time, of any project,
   * do not see the same numbers.
   */
  claim(
    claim: VmClaim,
    check: (starts: VmStartCounts) => Promise<UsageCheck>,
  ): Promise<{ ok: true; vm: RunVm; isNew: boolean } | UsageRefusal>;
  /**
   * Counts the start of a VM that takes no run (the prepare VM and the smoke VM of a build) when
   * `check` passes.
   * `check` gets the {@link VmStartCounts}, as in `claim`, and the start counts in them. The row stays `starting` with no reference until `markDeleted`, so no claim gets it.
   */
  claimStart(
    start: Pick<VmClaim, "projectId" | "versionId" | "now">,
    check: (starts: VmStartCounts) => Promise<UsageCheck>,
  ): Promise<{ ok: true; vm: RunVm } | UsageRefusal>;
  markReady(vmId: string, vmRef: string, now: Date): Promise<void>;
  /** The end of a run on the VM. */
  touch(vmId: string, now: Date): Promise<void>;
  markDeleted(vmId: string, now: Date): Promise<void>;
  get(vmId: string): Promise<RunVm | null>;
  /**
   * The VMs to delete: `ready` with no active run and not used since `idleSince`, and `starting`
   * since before `startingSince` (their process ended).
   */
  listIdle(idleSince: Date, startingSince: Date, limit: number): Promise<RunVm[]>;
  /**
   * Marks a VM of `listIdle` deleted when it is still idle by the same terms. It takes the lock of
   * `claim`, so no claim gets the VM after it. True when this call marked the VM.
   */
  retireIdle(
    vm: Pick<RunVm, "id" | "projectId">,
    idleSince: Date,
    startingSince: Date,
    now: Date,
  ): Promise<boolean>;
  /** Which of these VM ids are not deleted. */
  live(vmIds: readonly string[]): Promise<Set<string>>;
}
