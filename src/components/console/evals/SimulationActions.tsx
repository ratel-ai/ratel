"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { Checkbox } from "@ratel/design-system/checkbox";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@ratel/design-system/dialog";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { suiteOfRun } from "@/lib/views/evals/domain/simulation";
import type { SimulationPageModel } from "@/lib/views/evals/fix-page";
import { fixSimulationHref } from "@/lib/views/evals/paths";
import { useRunEvals } from "./FixSimulations";

/**
 * A simulation's actions (E4): "Add evals" picks more evals and runs the
 * larger suite as a new simulation; "Run again" repeats this suite. Each opens
 * the new simulation's table.
 */
export function SimulationActions({
  projectId,
  fixId,
  suite,
  evalIds,
  addable,
}: {
  projectId: string;
  fixId: string;
  suite: string;
  evalIds: readonly string[];
  addable: SimulationPageModel["addable"];
}) {
  const router = useRouter();
  const run = useRunEvals(projectId, fixId);
  const open = (runId: string) => router.push(fixSimulationHref(projectId, fixId, runId));
  return (
    <span className="flex items-center gap-2">
      <AddEvals
        addable={addable}
        pending={run.pending}
        onRun={(picked) => run.start({ kind: "list", evalIds: [...evalIds, ...picked] }, open)}
      />
      <Button
        variant="ghost"
        disabled={run.pending}
        onClick={() => run.start(suiteOfRun(suite, evalIds), open)}
      >
        {run.pending ? "Queuing…" : "Run again"}
      </Button>
    </span>
  );
}

function AddEvals({
  addable,
  pending,
  onRun,
}: {
  addable: SimulationPageModel["addable"];
  pending: boolean;
  onRun: (picked: string[]) => void;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string, on: boolean) =>
    setPicked((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <Dialog>
      <DialogTrigger
        className={buttonVariants({ variant: "secondary" })}
        disabled={pending || addable.length === 0}
      >
        Add evals
      </DialogTrigger>
      <DialogContent
        title="Add evals"
        description="The evals you pick run with this suite as a new simulation."
        footer={
          <>
            <DialogClose className={buttonVariants({ variant: "ghost" })}>Cancel</DialogClose>
            <DialogClose
              className={buttonVariants({ variant: "primary" })}
              disabled={picked.size === 0}
              onClick={() => onRun([...picked])}
            >
              {picked.size === 0 ? "Run" : `Run with ${picked.size} more`}
            </DialogClose>
          </>
        }
      >
        <ul
          className="flex max-h-80 flex-col gap-1 overflow-y-auto"
          aria-label="Evals not in this simulation"
        >
          {addable.map((item) => (
            <li key={item.id} className="flex items-center gap-2">
              <Checkbox
                checked={picked.has(item.id)}
                onCheckedChange={(on) => toggle(item.id, on)}
                label={item.name}
              />
              <span className="flex flex-wrap gap-1">
                {item.tasks.map((task) => (
                  <Badge key={task.id}>{task.label}</Badge>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
