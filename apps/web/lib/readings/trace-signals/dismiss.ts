import type { SignalKind } from "@/lib/readings/trace-signals/view";

/**
 * Signals a person may hide as "slow by design": a tool that is slow because
 * of what it does (a video render, a deploy, a wait on a job), which no fix
 * here will speed up. Hidden signals are `muted`, which signal runs never
 * reopen, and can be shown again from the list.
 */
export const DISMISSABLE_KINDS = [
  "latency_outlier",
  "wait_heavy",
] as const satisfies readonly SignalKind[];

export type DismissableKind = (typeof DISMISSABLE_KINDS)[number];

export function isDismissable(kind: SignalKind): kind is DismissableKind {
  return (DISMISSABLE_KINDS as readonly SignalKind[]).includes(kind);
}

/** A signal hidden as slow by design, for the "Show again" line. */
export interface DismissedSignal {
  id: string;
  kind: DismissableKind;
  /** The tool it is about. */
  toolId: string;
  /** The tool's display name, or its id. */
  label: string;
}
