/**
 * The one rule for "this task runs its steps in a fixed order": at least
 * `minSteps` core tools, first called in the task's typical order in at least
 * `minShare` of the runs that ran them all, over at least `minRuns` runs.
 *
 * Agent health's `workflow_fixed_chain` issue and the drafted fix that turns
 * the steps into one tool (`compose_chain` in `lib/tool-crafter`) both read
 * it, so every task that raises the issue can carry the fix, and no fix is
 * drafted for a task the issue calls loose. They used to disagree (0.9 over
 * 20 runs against 0.8 over 10). The env floors of `workflow_fixed_chain`
 * (`signals/catalog.ts`) override these defaults for both.
 */

export interface FixedOrderRule {
  readonly minRuns: number;
  readonly minShare: number;
  readonly minSteps: number;
}

export const FIXED_ORDER: FixedOrderRule = Object.freeze({
  minRuns: 20,
  minShare: 0.9,
  minSteps: 3,
});

/**
 * The same rule read for a pair: a merge of two tools (an intent's own
 * two-tool pattern, `pickIntentMergeCandidates` in `lib/tool-crafter`) is two
 * steps by definition, so only the step count differs; the runs and the share
 * are the one rule's.
 */
export const FIXED_PAIR_ORDER: FixedOrderRule = Object.freeze({ ...FIXED_ORDER, minSteps: 2 });

/** Whether a task runs in a fixed order under `rule`. */
export function runsInFixedOrder(
  task: {
    readonly runs: number;
    readonly coreTools: readonly string[];
    readonly orderStability: number;
  },
  rule: FixedOrderRule = FIXED_ORDER,
): boolean {
  return (
    task.runs >= rule.minRuns &&
    task.coreTools.length >= rule.minSteps &&
    task.orderStability >= rule.minShare
  );
}
