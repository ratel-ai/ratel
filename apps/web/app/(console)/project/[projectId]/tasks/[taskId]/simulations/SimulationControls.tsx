"use client";

import { Badge, StatusDot, type Tone } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import type { TaskSimulationState } from "@/lib/views/task-evals/simulation-view";
import { changeTaskSimulationAction } from "./actions";

export type SimulationScope = { projectId: string; taskId: string; fixId: string };
const STATES: Record<
  TaskSimulationState["state"],
  { label: string; tone: Exclude<Tone, "accent"> }
> = {
  none: { label: "Not simulated", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  better: { label: "Better", tone: "success" },
  worse: { label: "Worse", tone: "danger" },
  same: { label: "No overall change", tone: "neutral" },
  unreliable: { label: "Unreliable", tone: "warning" },
};

export function SimulationStatus({ state, stale }: TaskSimulationState) {
  const words = STATES[state];
  return (
    <span className="inline-flex items-center gap-2">
      <StatusDot {...words} />
      {stale ? <Badge tone="warning">Stale</Badge> : null}
    </span>
  );
}

export function RunTaskSimulationButton({
  scope,
  running,
  compact = false,
  disabled = false,
}: {
  scope: SimulationScope;
  running: boolean;
  compact?: boolean;
  disabled?: boolean;
}) {
  const { busy, submit } = useSimulationAction(scope);
  return (
    <Button
      variant={compact ? "secondary" : "primary"}
      size={compact ? "sm" : "md"}
      loading={busy}
      disabled={running || disabled}
      onClick={() => void submit({ action: "run" })}
    >
      {running ? "Running…" : compact ? "Simulate" : "Run"}
    </Button>
  );
}

export function SimulationPoller({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [active, router]);
  return active ? (
    <span className="sr-only" aria-live="polite">
      The simulation is running.
    </span>
  ) : null;
}

export function useSimulationAction(scope: SimulationScope) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const submit = (command: Record<string, unknown>): Promise<boolean> =>
    new Promise((resolve) => {
      startTransition(async () => {
        try {
          const result = await changeTaskSimulationAction({ ...scope, ...command });
          if (!result.ok) {
            toast({
              title: "Could not save the simulation",
              description: result.error,
              tone: "danger",
            });
            resolve(false);
            return;
          }
          toast({ title: result.message });
          router.refresh();
          resolve(true);
        } catch {
          toast({
            title: "Could not save the simulation",
            description: "Check your connection and try again.",
            tone: "danger",
          });
          resolve(false);
        }
      });
    });
  return { busy, submit };
}
