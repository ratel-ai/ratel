import type {
  UsageCheck,
  UsageLimitName,
  UsageLimitsPort,
  UsageSubject,
} from "@/lib/contracts/usage-limits";
import { getLogger } from "@/lib/platform/logger";
import type { StartVmRequest } from "./ports/sandbox-provider";
import type { VmStartCounts } from "./ports/vm-store";

/**
 * The budgets of VM starts, the same for each purpose (prepare, smoke, run). A project has a budget
 * for each UTC day, its organization one for all its projects, and the deployment one for each
 * minute, hour and UTC day over all projects: they share one provider account, and its plan limits
 * the starts. `VmStore.claim` and `VmStore.claimStart` reserve a start: they count the VM rows and
 * insert the new row in one transaction under the lock of the account, so two starts cannot both
 * take the last unit. The budgets count each attempt: a row stays counted also when its VM did not
 * start. Usage records only a start that succeeded (`recordVmStart`).
 */

const logger = getLogger("sandboxes/vm-starts");

/** Each budget with its count. The first that a start would pass refuses it, with its name. */
const BUDGETS: readonly [UsageLimitName, keyof VmStartCounts][] = [
  ["sandbox_vm_starts_per_day", "project"],
  ["sandbox_org_vm_starts_per_day", "organization"],
  ["sandbox_account_vm_starts_per_minute", "accountMinute"],
  ["sandbox_account_vm_starts_per_hour", "accountHour"],
  ["sandbox_account_vm_starts_per_day", "accountDay"],
];

/** The check that `VmStore.claim` and `VmStore.claimStart` call with the counts of the starts. */
export function vmStartCheck(
  limits: Pick<UsageLimitsPort, "check">,
  subject: UsageSubject,
): (starts: VmStartCounts) => Promise<UsageCheck> {
  return async (starts) => {
    for (const [name, scope] of BUDGETS) {
      const checked = await limits.check(subject, name, { current: starts[scope] });
      if (!checked.ok) return checked;
    }
    return { ok: true };
  };
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
