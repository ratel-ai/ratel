"use client";

import { Badge, StatusDot } from "@ratel/design-system/badge";
import { Switch } from "@ratel/design-system/checkbox";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";
import { changeScorerAction } from "@/app/(console)/project/[projectId]/scorers/actions";
import type { TaskOption } from "@/app/(console)/project/[projectId]/scorers/tasks";
import { formatPercent, MISSING } from "@/lib/synthesis/traces/v2/format";
import { formatAverage, KIND_LABELS, scoreLabel } from "@/lib/views/scorers/format";
import type { ScorerSummary } from "@/lib/views/scorers/store";
import type { ScorerKind, TraceScore } from "@/lib/views/scorers/types";

/** A scorer as its pages show it. */
export interface ScorerItem {
  id: string;
  name: string;
  kind: ScorerKind;
  /** What it checks, in one line. */
  summary: string;
  /** Pass or fail; false: 1 to 5. */
  verdict: boolean;
  sampleRate: number;
  /** The tasks it is attached to; null: every trace. */
  tasks: readonly TaskOption[] | null;
  enabled: boolean;
  /** The last 7 days; null without a result. */
  week: ScorerSummary | null;
}

export function KindBadge({ kind }: { kind: ScorerKind }) {
  return <Badge>{KIND_LABELS[kind]}</Badge>;
}

/** The tasks a scorer covers, in words. */
export function tasksLabel(tasks: readonly TaskOption[] | null): string {
  if (tasks === null) return "All traces";
  return tasks.length === 0 ? "No task" : tasks.map((task) => task.name).join(", ");
}

/** The pass rate, or the average of 1 to 5, of a summary. */
export function summaryValue({ verdict, week }: Pick<ScorerItem, "verdict" | "week">): string {
  if (!week) return MISSING;
  if (verdict) return week.passRate === null ? MISSING : formatPercent(week.passRate);
  return week.average === null ? MISSING : `${formatAverage(week.average)} of 5`;
}

/** One result: a dot and its word, or the number. */
export function ScoreValue({ score }: { score: Pick<TraceScore, "passed" | "value"> }) {
  if (score.passed === null) return <span className="tabular-nums">{scoreLabel(score)}</span>;
  return <StatusDot tone={score.passed ? "success" : "danger"} label={scoreLabel(score)} />;
}

/** The enabled switch: it changes at once, and back when the save fails. */
export function EnabledSwitch({
  projectId,
  scorer,
  label,
}: {
  projectId: string;
  scorer: Pick<ScorerItem, "id" | "name" | "enabled">;
  label: React.ReactNode;
}) {
  const router = useRouter();
  const [shown, setShown] = useOptimistic(scorer.enabled);
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      label={label}
      checked={shown}
      disabled={pending}
      onCheckedChange={(enabled) =>
        startTransition(async () => {
          setShown(enabled);
          const result = await changeScorerAction({
            projectId,
            action: "set_enabled",
            scorerId: scorer.id,
            enabled,
          });
          if (!result.ok)
            toast({
              title: "Couldn't change the scorer",
              description: result.error,
              tone: "danger",
            });
          router.refresh();
        })
      }
    />
  );
}
