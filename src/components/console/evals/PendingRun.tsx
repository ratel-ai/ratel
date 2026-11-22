"use client";

import { Callout } from "@ratel/design-system/states";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { EvalRun } from "@/lib/views/evals/domain/types";

const REFRESH_MS = 3_000;

/** RC-642: a run of this eval that is queued or running. The page reads it again until the run ends. */
export function PendingRun({ run }: { run: EvalRun }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [router]);
  return (
    <Callout title={run.status === "running" ? "Simulating" : "Queued"}>
      <span data-pending-run>
        The eval runs again with your change. This page shows the new run when it ends.
      </span>
    </Callout>
  );
}
