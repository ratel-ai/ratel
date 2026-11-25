"use client";

import { Button } from "@ratel/design-system/button";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLinkItem,
  MenuSeparator,
  MenuTrigger,
} from "@ratel/design-system/menu";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { changeScorerAction } from "@/app/(console)/project/[projectId]/scorers/actions";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import { newTaskScorerHref, scorersHref } from "@/lib/views/scorers/paths";
import type { AttachableScorer, TaskScorerScores } from "@/lib/views/scorers/task-scores";
import { KindBadge, summaryValue } from "./parts";
import { ScoreTrend } from "./ScoreTrend";

/** A task's scorers: the global ones attached to it, each with its trend, Add scorer and Detach. */
export function TaskLiveScores({
  projectId,
  taskId,
  scorers,
  attachable,
}: {
  projectId: string;
  taskId: string;
  scorers: readonly TaskScorerScores[];
  attachable: readonly AttachableScorer[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [narrowing, setNarrowing] = useState<AttachableScorer | null>(null);

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

  async function attach(scorer: AttachableScorer, narrow: boolean) {
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

  const add = (
    <Menu>
      <MenuTrigger render={<Button variant="secondary" loading={pending} />}>
        Add scorer
      </MenuTrigger>
      <MenuContent align="end" className="max-h-80 max-w-80 overflow-y-auto">
        {attachable.length > 0 ? (
          <>
            <MenuGroup label="Attach a scorer">
              {attachable.map((scorer) => (
                <MenuItem
                  key={scorer.id}
                  onClick={() =>
                    scorer.everyTrace
                      ? setNarrowing(scorer)
                      : startTransition(() => attach(scorer, false))
                  }
                >
                  {scorer.name}
                  {scorer.everyTrace ? (
                    <span className="ml-2 text-xs text-fg-subtle">All traces</span>
                  ) : null}
                </MenuItem>
              ))}
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuLinkItem render={<Link href={newTaskScorerHref(projectId, taskId)} />}>
          Create scorer for this task
        </MenuLinkItem>
      </MenuContent>
    </Menu>
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
                  <Link
                    href={`${scorersHref(projectId)}/${scorer.id}`}
                    className="text-fg hover:underline"
                  >
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
                <Button
                  variant="ghost"
                  disabled={pending}
                  aria-label={`Detach ${scorer.name}`}
                  onClick={() => detach(scorer)}
                >
                  Detach
                </Button>
              </div>
              <ScoreTrend days={scorer.trend} verdict={scorer.verdict} />
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
