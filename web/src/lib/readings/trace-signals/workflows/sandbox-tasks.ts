/**
 * Tasks of Ratel sandboxes (RP-445). A run of an agent on a Ratel sandbox belongs to one task: the
 * task of its sandbox, `sandbox:<name>`. The sandboxes module writes it to `trace_turns.workflow_id`
 * when the turn of the run is built, so the run has its task at once, with no mining. It works like
 * the task of an agent (`agent-tasks.ts`): a task id with a prefix, in the one column of tasks. A
 * signal run never moves or clears it (`place-queries.ts`).
 */

export const SANDBOX_TASK_PREFIX = "sandbox:";

/** The task of the runs of a sandbox. */
export function sandboxTaskId(sandbox: string): string {
  return `${SANDBOX_TASK_PREFIX}${sandbox}`;
}

/** Whether a task id is the task of a sandbox. */
export function isSandboxTaskId(id: string): boolean {
  return id.startsWith(SANDBOX_TASK_PREFIX) && id.length > SANDBOX_TASK_PREFIX.length;
}

/** The name of the sandbox of a sandbox task, or null for any other id. */
export function sandboxOfTask(id: string): string | null {
  return isSandboxTaskId(id) ? id.slice(SANDBOX_TASK_PREFIX.length) : null;
}
