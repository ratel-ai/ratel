"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@ratel/design-system/menu";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { FlaskConical, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { simulateFixAction } from "@/lib/views/evals/actions";
import type { SimulationSuite } from "@/lib/views/evals/domain/simulation";
import type { FixPageModel } from "@/lib/views/evals/fix-page";
import { fixSimulationHref } from "@/lib/views/evals/paths";
import {
  type RunEvalsMenu,
  type RunEvalsOption,
  runEvalsOptions,
  simulationLineText,
} from "@/lib/views/evals/view";
import { RunStatus } from "./marks";

const TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
/** A queued line turns into its result without a reload. */
const REFRESH_MS = 5000;

type Line = FixPageModel["lines"][number];

/**
 * A fix's simulations (E1, E3): one line each, newest first, with suite,
 * tasks, "5/5 pass · today 2", "3 fixed · 1 broke" and when. "Run evals"
 * queues another suite as a new line, first queued and then with its result.
 */
export function FixSimulations({
  projectId,
  fixId,
  lines,
  menu,
}: {
  projectId: string;
  fixId: string;
  lines: readonly Line[];
  menu: RunEvalsMenu;
}) {
  const router = useRouter();
  const live = lines.some((line) => line.run.status === "queued" || line.run.status === "running");
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, router]);
  return (
    <Section
      title="Simulations"
      actions={<RunEvalsButton projectId={projectId} fixId={fixId} menu={menu} />}
    >
      {lines.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="No simulations yet"
          description="Run evals to replay the suite with this fix and compare it with the agent today."
        />
      ) : (
        <ul
          className="flex flex-col divide-y divide-line border-y border-line"
          aria-label="Simulations"
        >
          {lines.map((line) => (
            <SimulationLineRow key={line.run.id} projectId={projectId} fixId={fixId} line={line} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/** The "Run evals" menu (E3): the fix's own tasks, all evals, the evals failing today, or one task's. */
export function RunEvalsButton({
  projectId,
  fixId,
  menu,
}: {
  projectId: string;
  fixId: string;
  menu: RunEvalsMenu;
}) {
  const run = useRunEvals(projectId, fixId);
  const options = runEvalsOptions(menu);
  const entry = ({ label, count, suite }: RunEvalsOption) => (
    <MenuItem key={label} disabled={count === 0 || run.pending} onClick={() => run.start(suite)}>
      <span className="flex w-full items-center justify-between gap-4">
        <span className="truncate">{label}</span>
        <span className="text-fg-subtle tabular-nums">{count}</span>
      </span>
    </MenuItem>
  );
  return (
    <Menu>
      <MenuTrigger
        className={buttonVariants({ variant: "secondary", size: "sm" })}
        disabled={run.pending}
      >
        <Play aria-hidden />
        {run.pending ? "Queuing…" : "Run evals"}
      </MenuTrigger>
      <MenuContent align="end" className="w-72">
        {options.suites.map(entry)}
        {options.tasks.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuGroup label="One task">{options.tasks.map(entry)}</MenuGroup>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

/** Queue a simulation of a suite, say so, and show its new line. */
export function useRunEvals(projectId: string, fixId: string) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const start = (suite: SimulationSuite, onQueued?: (runId: string) => void) =>
    startTransition(async () => {
      const result = await simulateFixAction(projectId, fixId, suite);
      if (!result.ok) {
        toast({ title: "Could not run the evals", description: result.error, tone: "danger" });
        return;
      }
      toast({
        title: "Simulation queued",
        description: `${result.value.evalCount} ${result.value.evalCount === 1 ? "eval" : "evals"} will run without and with the fix.`,
      });
      if (onQueued) onQueued(result.value.id);
      else router.refresh();
    });
  return { pending, start };
}

function SimulationLineRow({
  projectId,
  fixId,
  line,
}: {
  projectId: string;
  fixId: string;
  line: Line;
}) {
  const { run, tally, taskTags, suite } = line;
  const done = run.status === "completed";
  const text = simulationLineText(tally);
  const tasks =
    taskTags.length === 1
      ? taskTags[0]!.label
      : taskTags.length > 1
        ? `${taskTags.length} tasks`
        : `${run.evalCount} ${run.evalCount === 1 ? "eval" : "evals"}`;
  return (
    <li data-status={run.status}>
      <Link
        href={fixSimulationHref(projectId, fixId, run.id)}
        className="grid grid-cols-[1rem_10rem_1fr_auto_auto_7rem] items-center gap-4 px-2 py-3 text-ui outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span
          aria-hidden
          className={cn(
            "size-2.5 rounded-[2px]",
            !done
              ? "border border-dashed border-line-strong"
              : tally.broke > 0
                ? "bg-danger"
                : "bg-success",
          )}
        />
        <span className="truncate font-medium text-fg">{suite}</span>
        <span className="truncate text-fg-muted">{tasks}</span>
        {done ? (
          <>
            <span className="tabular-nums">
              <span className="font-semibold text-fg">{text.pass}</span>{" "}
              <span className="text-fg-muted">pass · {text.today}</span>
            </span>
            <span className="text-fg-muted">
              {tally.fixed > 0 ? <span className="text-success">{tally.fixed} fixed</span> : null}
              {tally.fixed > 0 && tally.broke > 0 ? " · " : null}
              {tally.broke > 0 ? <span className="text-danger">{tally.broke} broke</span> : null}
              {tally.unverified > 0 ? (
                <>
                  {tally.fixed + tally.broke > 0 ? " · " : null}
                  <span className="text-warning">{tally.unverified} unverified</span>
                </>
              ) : null}
              {tally.fixed + tally.broke + tally.unverified === 0 ? text.change : null}
            </span>
          </>
        ) : (
          <>
            <RunStatus status={run.status} />
            <span className="text-fg-muted">
              {run.status === "failed"
                ? (run.error ?? "The simulation failed.")
                : `${run.evalCount} ${run.evalCount === 1 ? "eval" : "evals"}`}
            </span>
          </>
        )}
        <span className="text-right text-fg-muted tabular-nums">{TIME.format(run.createdAt)}</span>
      </Link>
    </li>
  );
}
