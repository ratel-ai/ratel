import { RQL_LIMITS } from "./limits";

/**
 * Caps the RQL queries one project runs at the same time, in this process. `enter` gives the
 * function that frees the place, or `undefined` when the project has no free place. `wait` queues
 * for a place up to `waitMs`, in the order of the calls, and gives `undefined` when none came free:
 * a dashboard that reads more queries than the cap waits for its own places instead of failing.
 */
export interface RqlGate {
  enter(projectId: string): (() => void) | undefined;
  wait(projectId: string, waitMs: number): Promise<(() => void) | undefined>;
}

export function createRqlGate(max: number = RQL_LIMITS.parallelQueriesPerProject): RqlGate {
  const running = new Map<string, number>();
  const waiting = new Map<string, (() => void)[]>();

  const enter = (projectId: string): (() => void) | undefined => {
    const count = running.get(projectId) ?? 0;
    if (count >= max) return undefined;
    running.set(projectId, count + 1);
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      const left = (running.get(projectId) ?? 1) - 1;
      if (left === 0) running.delete(projectId);
      else running.set(projectId, left);
      waiting.get(projectId)?.shift()?.();
    };
  };

  return {
    enter: (projectId) =>
      (waiting.get(projectId)?.length ?? 0) > 0 ? undefined : enter(projectId),
    wait(projectId, waitMs) {
      if ((waiting.get(projectId)?.length ?? 0) === 0) {
        const leave = enter(projectId);
        if (leave) return Promise.resolve(leave);
      }
      return new Promise((resolve) => {
        const queue = waiting.get(projectId) ?? [];
        waiting.set(projectId, queue);
        const wake = () => {
          clearTimeout(timer);
          if (queue.length === 0) waiting.delete(projectId);
          resolve(enter(projectId));
        };
        const timer = setTimeout(() => {
          const at = queue.indexOf(wake);
          if (at >= 0) queue.splice(at, 1);
          if (queue.length === 0) waiting.delete(projectId);
          resolve(undefined);
        }, waitMs);
        queue.push(wake);
      });
    },
  };
}
