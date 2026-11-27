"use client";

import { Button } from "@ratel/design-system/button";
import { Panel } from "@ratel/design-system/panel";
import { Callout, Skeleton } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { scorerFormAction } from "@/app/(console)/project/[projectId]/scorers/actions";
import type { TaskOption } from "@/app/(console)/project/[projectId]/scorers/tasks";
import type { TraceFilterFacets } from "@/lib/synthesis/traces/trace-filters";
import { formatInteger, formatMoney } from "@/lib/synthesis/traces/v2/format";
import { definitionSummary, hasVerdict, limitText } from "@/lib/views/scorers/format";
import type { PickerScorer, ScorerPickerData } from "@/lib/views/scorers/picker";
import type { ScorerDraft } from "@/lib/views/scorers/types";
import { ScorerFormBody } from "./ScorerForm";
import { useScorerPicker } from "./ScorerPickerProvider";

/** Which scorer the Panel holds: a new one (with the task it starts from), or one to edit. */
export type ScorerPanelTarget = { scorerId: null; taskId?: string } | { scorerId: string };

type FormRead =
  | {
      ok: true;
      facets: TraceFilterFacets;
      tasks: TaskOption[];
      scorer: (ScorerDraft & { id: string }) | null;
    }
  | { ok: false; error: string };

const NO_USE = { widgets: 0, alerts: 0, tasks: 0, total: 0 };

/**
 * Create or edit a scorer without leaving the surface. The save keeps the surface's own state: the
 * scorer joins the surface's list at once, and `onSaved` gets it.
 */
export function ScorerPanel({
  target,
  onClose,
  onSaved,
}: {
  /** Null: closed. */
  target: ScorerPanelTarget | null;
  onClose: () => void;
  onSaved?: (scorer: PickerScorer, created: boolean) => void;
}) {
  const router = useRouter();
  const picker = useScorerPicker();
  // The last target stays while the Panel closes, so it does not blank.
  const [shown, setShown] = useState(target);
  const [read, setRead] = useState<{ key: string; form: FormRead } | null>(null);
  // Each opening reads the scorer again and starts a fresh form, so a reopen shows the last save.
  const [openings, setOpenings] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);
  if ((target !== null) !== wasOpen) {
    setWasOpen(target !== null);
    if (target) setOpenings((n) => n + 1);
  }
  if (target && target !== shown) setShown(target);
  const key = target ? `${openings}:${JSON.stringify(target)}` : null;
  const shownKey = shown ? `${openings}:${JSON.stringify(shown)}` : null;
  const projectId = picker?.projectId;

  useEffect(() => {
    if (!key || !projectId) return;
    const { scorerId } = JSON.parse(key.slice(key.indexOf(":") + 1)) as ScorerPanelTarget;
    let current = true;
    scorerFormAction(projectId, scorerId)
      .catch(() => ({ ok: false as const, error: "Could not open the scorer. Try again." }))
      .then((form) => {
        if (current) setRead({ key, form });
      });
    return () => {
      current = false;
    };
  }, [key, projectId]);

  if (!picker) return null;
  const editing = shown?.scorerId ?? null;
  const form = read && read.key === shownKey ? read.form : null;

  function saved({ scorerId, draft }: { scorerId: string; draft: ScorerDraft }) {
    if (!picker) return;
    const before = picker.data.scorers.find(({ id }) => id === scorerId);
    const scorer: PickerScorer = {
      id: scorerId,
      name: draft.name,
      kind: draft.kind,
      summary: definitionSummary(draft),
      verdict: hasVerdict(draft),
      enabled: draft.enabled,
      tasks: draft.tasks,
      usage: before?.usage ?? NO_USE,
    };
    picker.keep(scorer);
    toast({ title: editing ? "Scorer saved" : "Scorer created", tone: "success" });
    onSaved?.(scorer, editing === null);
    onClose();
    // The page reads the scorers again; its own state stays.
    router.refresh();
  }

  return (
    <Panel
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={editing ? "Edit scorer" : "New scorer"}
      size="wide"
      // A picker may be in a Dialog: the widget editor.
      layer="dialog"
    >
      <div className="flex flex-col gap-6">
        {editing ? null : <Room data={picker.data} />}
        {!form ? (
          <Skeleton className="h-96 w-full" />
        ) : !form.ok ? (
          <Callout tone="danger" title="The scorer could not be opened">
            {form.error}
          </Callout>
        ) : (
          <ScorerFormBody
            // A new read starts a fresh form.
            key={shownKey ?? undefined}
            projectId={picker.projectId}
            facets={form.facets}
            tasks={form.tasks}
            initialTask={
              shown && shown.scorerId === null
                ? form.tasks.find(({ id }) => id === shown.taskId)?.id
                : undefined
            }
            scorer={form.scorer}
            onSaved={saved}
            cancel={
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            }
          />
        )}
      </div>
    </Panel>
  );
}

/** Edit a scorer in a Panel, in place: "Edit" beside it in a list. */
export function EditScorerButton({ scorer }: { scorer: { id: string; name: string } }) {
  const [target, setTarget] = useState<ScorerPanelTarget | null>(null);
  return (
    <>
      <Button
        variant="ghost"
        aria-label={`Edit ${scorer.name}`}
        onClick={() => setTarget({ scorerId: scorer.id })}
      >
        Edit
      </Button>
      <ScorerPanel target={target} onClose={() => setTarget(null)} />
    </>
  );
}

/** The room left to create: the scorers against the limit, and the judges' daily budget. */
function Room({ data }: { data: ScorerPickerData }) {
  const { count, limit, budget } = data;
  const room = limitText(count, limit);
  return (
    <p className={room.full ? "text-ui text-warning" : "text-ui text-fg-muted"}>
      {`${room.text} Judged scorers have ${formatMoney(budget.leftUsd)} of ${formatMoney(budget.dailyUsd)} left today.`}
    </p>
  );
}
