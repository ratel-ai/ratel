"use client";

import { Button } from "@ratel/design-system/button";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { changeScorerAction } from "@/app/(console)/project/[projectId]/scorers/actions";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import { scorerHref } from "@/lib/views/scorers/paths";
import type { PickerScorer } from "@/lib/views/scorers/picker";
import type { TaskScorerScores } from "@/lib/views/scorers/task-scores";
import { EnabledSwitch, KindBadge, summaryValue } from "./parts";
import { EditScorerButton } from "./ScorerPanel";
import { ScorerPicker } from "./ScorerPicker";
import { ScoreTrend } from "./ScoreTrend";
import { StillCalculating } from "./StillCalculating";

/**
 * A task's scorers: the global ones attached to it, each with its trend, Edit and Detach. Add scorer
 * picks one of the project (inside a `ScorerPickerProvider`), or creates one for this task.
 */
export function TaskLiveScores({
  projectId,
  taskId,
  scorers,
}: {
  projectId: string;
  taskId: string;
  scorers: readonly TaskScorerScores[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [narrowing, setNarrowing] = useState<PickerScorer | null>(null);

  /** True when the change was saved. A failure is a toast. */
  async function change(
    scorer: { id: string },
    action: { action: "attach"; narrow: boolean } | { action: "detach" },
  ): Promise<boolean> {
    const result = await changeScorerAction({
      projectId,
      taskId,
      scorerId: scorer.id,
      ...action,
    }).catch(() => ({ ok: false as const, error: "Try again in a moment." }));
    if (!result.ok)
      toast({ title: "Couldn't change the scorer", description: result.error, tone: "danger" });
    router.refresh();
    return result.ok;
  }

  async function attach(scorer: PickerScorer, narrow: boolean) {
    if (await change(scorer, { action: "attach", narrow }))
      toast({ title: `Attached ${scorer.name}`, tone: "success" });
  }

  function detach(scorer: TaskScorerScores) {
    startTransition(async () => {
      if (!(await change(scorer, { action: "detach" }))) return;
      toast({
        title: `Detached ${scorer.name}`,
        description:
          scorer.tasks.length === 1
            ? "It has no task left, so it scores no traces. Its results stay."
            : "It stops scoring this task. Its results stay.",
        action: {
          label: "Undo",
          onClick: () =>
            startTransition(async () => {
              await change(scorer, { action: "attach", narrow: false });
            }),
        },
      });
    });
  }

  function picked(scorer: PickerScorer | null) {
    if (!scorer) return;
    // A scorer created here already has the task.
    if (scorer.tasks?.includes(taskId)) router.refresh();
    else if (scorer.tasks === null) setNarrowing(scorer);
    else startTransition(() => attach(scorer, false));
  }

  const add = (
    <ScorerPicker
      value={null}
      onChange={(_, scorer) => picked(scorer)}
      filter={(scorer) => !scorer.tasks?.includes(taskId)}
      taskId={taskId}
      trigger={{ render: <Button variant="secondary" loading={pending} />, children: "Add scorer" }}
    />
  );
  return (
    <Section
      title="Scorers"
      description="The scorers of this task's traces, by day for the last 14 days (UTC)."
      actions={scorers.length > 0 ? add : undefined}
    >
      {scorers.length === 0 ? (
        <EmptyState
          emblem
          title="No scorers for this task yet"
          description="A scorer of this task gives each of its new traces one result."
          action={add}
        />
      ) : (
        <ul className="flex flex-col gap-8">
          {scorers.map((scorer) => (
            <li key={scorer.id} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="text-sm font-medium">
                  <Link href={scorerHref(projectId, scorer.id)} className="text-fg hover:underline">
                    {scorer.name}
                  </Link>
                </h3>
                <KindBadge kind={scorer.kind} />
                {scorer.enabled ? null : <span className="text-xs text-fg-subtle">Off</span>}
                <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">
                  {scorer.summary}
                </span>
                <span className="text-sm text-fg tabular-nums">{summaryValue(scorer)}</span>
                <span className="text-xs text-fg-subtle tabular-nums">
                  {`${formatInteger(scorer.week?.scored ?? 0)} scored, 7 days`}
                </span>
                <EditScorerButton scorer={scorer} />
                <Button
                  variant="ghost"
                  disabled={pending}
                  aria-label={`Detach ${scorer.name}`}
                  onClick={() => detach(scorer)}
                >
                  Detach
                </Button>
              </div>
              {scorer.offAfterConversion ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-bg-subtle px-3 py-2">
                  <p className="min-w-0 flex-1 text-xs text-fg-subtle">
                    {`Off after the move to scorers: this judge makes no model call. Turn it on to judge new traces. It reads ${scorer.sampleRate}% of them, from the time you turn it on, within the organization's daily model budget.`}
                  </p>
                  <EnabledSwitch projectId={projectId} scorer={scorer} label="Turn on" />
                </div>
              ) : null}
              {scorer.trend.every(({ scored }) => scored === 0) ? (
                <StillCalculating padded={false} />
              ) : (
                <ScoreTrend days={scorer.trend} verdict={scorer.verdict} />
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={narrowing !== null}
        onOpenChange={(open) => {
          if (!open) setNarrowing(null);
        }}
        title={`Attach ${narrowing?.name ?? "the scorer"} to this task?`}
        description="It scores all traces now. After this, it scores only the new traces of this task."
        confirmLabel="Attach scorer"
        onConfirm={async () => {
          if (narrowing) await attach(narrowing, true);
          setNarrowing(null);
        }}
      />
    </Section>
  );
}
