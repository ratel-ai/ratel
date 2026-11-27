import { RQL_LIMITS } from "./limits";

/**
 * Caps the RQL queries one project runs at the same time, in this process. `enter` gives the
 * function that frees the place, or `undefined` when the project has no free place.
 */
export interface RqlGate {
  enter(projectId: string): (() => void) | undefined;
}

export function createRqlGate(max: number = RQL_LIMITS.parallelQueriesPerProject): RqlGate {
  const running = new Map<string, number>();
  return {
    enter(projectId) {
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
      };
    },
  };
}
