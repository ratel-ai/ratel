"use client";

import { Button } from "@ratel/design-system/button";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { runEvalsAction } from "@/lib/views/evals/actions";

/** Queue a manual run of every approved eval, or of the filtered task's (C5). */
export function RunAllButton({
  projectId,
  task,
  disabled,
}: {
  projectId: string;
  task: string | null;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="primary"
      disabled={disabled || pending}
      onClick={() =>
        start(async () => {
          const result = await runEvalsAction(projectId, task);
          if (!result.ok) {
            toast({ title: "Could not start the run", description: result.error, tone: "danger" });
            return;
          }
          toast({
            title: "Run queued",
            description: `${result.value.evalCount} ${result.value.evalCount === 1 ? "eval" : "evals"} will run against the agent as recorded.`,
          });
          router.refresh();
        })
      }
    >
      {pending ? "Queuing…" : task ? "Run this task's evals" : "Run all"}
    </Button>
  );
}
