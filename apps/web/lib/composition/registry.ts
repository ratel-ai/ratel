import { composition } from "@/lib/composition/ports";
import type { DrainStep, JobHandler, Registration } from "@/lib/contracts/registry";

/**
 * The other composition root: the one file that imports every module's `register.ts` and so the
 * one file `check-layers` exempts from the downward-only rule. Core modules are listed here as
 * they land; the Cloud edition contributes through the registry port.
 */
const CORE: Registration[] = [];

export function collectRegistrations(
  core: Registration[] = CORE,
  extra: Registration[] = composition.registry.registrations(),
): Registration[] {
  return [...core, ...extra];
}

/** Every job kind with its handler; a kind registered twice is a configuration error. */
export function jobHandlers(registrations: Registration[] = collectRegistrations()): Record<string, JobHandler> {
  const out: Record<string, JobHandler> = {};
  for (const r of registrations) {
    for (const [kind, handler] of Object.entries(r.jobs ?? {})) {
      if (kind in out) throw new Error(`job kind registered twice: ${kind}`);
      out[kind] = handler;
    }
  }
  return out;
}

/** Drain steps in registration order, `before` steps first. */
export function drainSteps(registrations: Registration[] = collectRegistrations()): DrainStep[] {
  const all = registrations.flatMap((r) => r.drainSteps ?? []);
  const names = new Set<string>();
  for (const step of all) {
    if (names.has(step.name)) throw new Error(`drain step registered twice: ${step.name}`);
    names.add(step.name);
  }
  return [...all.filter((s) => s.phase === "before"), ...all.filter((s) => s.phase === "after")];
}
