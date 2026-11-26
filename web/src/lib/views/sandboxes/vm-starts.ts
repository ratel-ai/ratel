import type { UsageCheck, UsageLimitsPort, UsageSubject } from "@/lib/contracts/usage-limits";
import { getLogger } from "@/lib/platform/logger";
import type { StartVmRequest } from "./ports/sandbox-provider";

/**
 * The daily budget of VM starts of a project, the same for each purpose (prepare, smoke, run).
 * `VmStore.claim` and `VmStore.claimStart` reserve a start: they count the VM rows of the project
 * of this UTC day and insert the new row in one transaction under the lock of the project, so two
 * starts cannot both take the last unit. The budget counts each attempt: a row stays counted also
 * when its VM did not start. Usage records only a start that succeeded (`recordVmStart`).
 */

const logger = getLogger("sandboxes/vm-starts");

/** The check that `VmStore.claim` and `VmStore.claimStart` call with the starts of today. */
export function vmStartCheck(
  limits: Pick<UsageLimitsPort, "check">,
  subject: UsageSubject,
): (startsToday: number) => Promise<UsageCheck> {
  return (startsToday) =>
    limits.check(subject, "sandbox_vm_starts_per_day", { current: startsToday });
}

/** Records the usage of a VM that started, by its row id. A failure is logged. */
export async function recordVmStart(
  limits: Pick<UsageLimitsPort, "record">,
  subject: UsageSubject,
  vmId: string,
  purpose: StartVmRequest["purpose"],
): Promise<void> {
  try {
    await limits.record(subject, { kind: "sandbox_vm_start", reference: vmId });
  } catch (error) {
    logger.error(
      { project_id: subject.projectId, vm_id: vmId, purpose, err: error },
      "vm start not recorded",
    );
  }
}
