"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { NounIcon, ToolPin } from "@ratel/design-system/entity";
import { Panel } from "@ratel/design-system/panel";
import { stepIndex } from "@ratel/design-system/peek";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { CircleCheck, SearchX } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  applyAllProposalsAction,
  applyProposalAction,
  dismissProposalAction,
  revertProposalAction,
} from "@/app/(console)/project/[projectId]/improvement/match-quality/actions";
import { formatTimestamp } from "@/lib/synthesis/traces/format";
import { relativeTimeLabel } from "@/lib/views/fixes/relative-time";
import {
  catalogEditHref,
  descriptionsSearch,
  type OpenTarget,
  openTarget,
  type RewriteRow,
  revertedToast,
  rewritesCount,
  type ToolCard,
} from "@/lib/views/quality/descriptions";
import { appliedToast, NOT_REACHING_RUNTIME, settle } from "@/lib/views/quality/suggestions";
import { FoundMeter } from "./FoundMeter";
import { EffectDelta, RewriteDetail } from "./RewriteDetail";
import { ToolCardDetail } from "./ToolCardDetail";

type Acted = "applied" | "dismissed" | "reverted";

/**
 * The rewrites to review and the ones already applied, each a tool, how often
 * searches missed it, and what a replay says the rewrite does. A row opens the
 * Panel with the before and after; Apply, Dismiss and Revert call Match
 * quality's own actions. A row leaves its list at once and comes back if the
 * action fails; applying is reversible, so it confirms with an Undo toast.
 */
export function RewritesList({
  projectId,
  pending,
  applied,
  overridesAdopted,
  experimentName,
  toolCard,
  windowPhrase,
  now,
}: {
  projectId: string;
  pending: readonly RewriteRow[];
  applied: readonly RewriteRow[];
  overridesAdopted: boolean | null;
  experimentName: string | null;
  /** The tool `?tool=` asked for, when it has no rewrite. */
  toolCard: ToolCard | null;
  windowPhrase: string;
  now: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [acted, setActed] = useState<ReadonlyMap<string, Acted>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [lastOpen, setLastOpen] = useState<OpenTarget<RewriteRow> | null>(null);
  const at = useMemo(() => new Date(now), [now]);

  const mark = (ids: readonly string[], state: Acted | null) =>
    setActed((current) => {
      const next = new Map(current);
      for (const id of ids) {
        if (state === null) next.delete(id);
        else next.set(id, state);
      }
      return next;
    });
  const setBusyRows = (ids: readonly string[], on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const toReview = pending.filter((row) => !acted.has(row.id));
  const live = applied.filter((row) => acted.get(row.id) !== "reverted");
  const all = [...toReview, ...live];
  // A rewrite being applied leaves its table at once but stays open in the
  // Panel; only a dismissed or reverted one closes it.
  const openable = [
    ...pending.filter(
      (row) => acted.get(row.id) !== "dismissed" && acted.get(row.id) !== "reverted",
    ),
    ...live,
  ];
  const target = openTarget(openable, searchParams.get("peek"), searchParams.get("tool"));
  const open = target?.kind === "tool" && toolCard?.id !== target.toolId ? null : target;
  const showing = open ?? lastOpen;

  const navigate = useCallback(
    (peek: string | null) => {
      window.history.replaceState(
        null,
        "",
        `${pathname}${descriptionsSearch(window.location.search, peek)}`,
      );
    },
    [pathname],
  );
  const openRow = (row: RewriteRow) => {
    setLastOpen({ kind: "rewrite", row });
    navigate(row.peek);
  };
  const close = () => {
    if (open) setLastOpen(open);
    navigate(null);
  };
  const step = (direction: 1 | -1) => {
    const index = open?.kind === "rewrite" ? all.indexOf(open.row) : -1;
    const next = all[stepIndex(index, direction, all.length)];
    if (next) openRow(next);
  };

  /**
   * Hide the rows at once, run the existing action, and on any failure (an
   * error answer or a throw) put them back and say why. Undo runs from a toast
   * made a render earlier; by then the server's list has them applied.
   */
  const run = (
    rows: readonly RewriteRow[],
    state: Acted,
    action: () => Promise<{ ok: boolean; message?: string }>,
    done: () => void,
  ) => {
    const ids = rows.map((row) => row.id);
    const before = new Map(ids.map((id) => [id, acted.get(id) ?? null]));
    setBusyRows(ids, true);
    mark(ids, state);
    startTransition(async () => {
      const outcome = await settle(action);
      setBusyRows(ids, false);
      if (!outcome.ok) {
        for (const [id, previous] of before) mark([id], previous);
        toast({
          title:
            rows.length === 1
              ? `Couldn't update ${rows[0]!.toolName}`
              : "Couldn't apply the rewrites",
          description: outcome.message,
          tone: "danger",
        });
        return;
      }
      done();
      router.refresh();
    });
  };

  const revert = (row: RewriteRow, how: "undo" | "revert") =>
    run(
      [row],
      "reverted",
      () => revertProposalAction(projectId, row.id, "quality"),
      () => toast(revertedToast(row.toolName, how)),
    );

  const apply = (row: RewriteRow) =>
    run(
      [row],
      "applied",
      () => applyProposalAction(projectId, row.id, "quality"),
      () =>
        toast({
          ...appliedToast(row.toolName, overridesAdopted),
          tone: "success",
          action: { label: "Undo", onClick: () => revert(row, "undo") },
        }),
    );

  const dismiss = (row: RewriteRow) =>
    run(
      [row],
      "dismissed",
      () => dismissProposalAction(projectId, row.id, "quality"),
      () =>
        toast({ title: "Rewrite dismissed", description: "A later analysis can draft it again." }),
    );

  const applyAll = () => {
    const rows = [...toReview];
    let appliedIds: string[] = [];
    run(
      rows,
      "applied",
      async () => {
        const result = await applyAllProposalsAction(projectId, "quality");
        appliedIds = result.applied ?? [];
        return result;
      },
      () =>
        toast({
          title: `Applied ${rewritesCount(appliedIds.length)}`,
          description:
            overridesAdopted === true
              ? "Searches match the new wording now."
              : "Saved in Cloud; your agent gets them once it attaches with Cloud definitions.",
          tone: "success",
          action: {
            label: "Undo",
            onClick: () => {
              const undone = rows.filter((row) => appliedIds.includes(row.id));
              run(
                undone,
                "reverted",
                async () => {
                  for (const row of undone) {
                    const result = await revertProposalAction(projectId, row.id, "quality");
                    if (!result.ok) return result;
                  }
                  return { ok: true };
                },
                () =>
                  toast({
                    title: "Rewrites undone",
                    description: "Each tool is back to its previous searchable description.",
                  }),
              );
            },
          },
        }),
    );
  };

  const actions = (row: RewriteRow, size: "sm" | "md" = "sm") =>
    row.status === "pending" && acted.get(row.id) !== "applied" ? (
      <span className="flex items-center justify-end gap-1">
        <Button
          size={size}
          variant={size === "md" ? "primary" : "secondary"}
          loading={busy.has(row.id)}
          onClick={() => apply(row)}
        >
          Apply rewrite
        </Button>
        <Button
          size={size}
          variant="ghost"
          disabled={busy.has(row.id)}
          onClick={() => dismiss(row)}
        >
          Dismiss
        </Button>
      </span>
    ) : (
      <Button
        size={size}
        variant="ghost"
        loading={busy.has(row.id)}
        onClick={() => revert(row, "revert")}
      >
        Revert
      </Button>
    );

  const tool: Column<RewriteRow> = {
    id: "tool",
    header: "Tool",
    className: "w-full max-w-0 min-w-40",
    cell: (row) => <ToolPin name={row.toolName} />,
  };
  const effect: Column<RewriteRow> = {
    id: "effect",
    header: "Found in a replay",
    width: "14.5rem",
    className: "sm:min-w-58",
    cell: (row) => <EffectCell row={row} />,
  };
  const actionsColumn: Column<RewriteRow> = {
    id: "actions",
    header: <span className="sr-only">Actions</span>,
    align: "right",
    width: "13rem",
    hiddenBelow: "md",
    className: "min-w-52",
    cell: (row) => actions(row),
  };
  const pendingColumns: readonly Column<RewriteRow>[] = [
    tool,
    {
      id: "missed",
      header: "Missed",
      align: "right",
      width: "6.5rem",
      className: "sm:min-w-24",
      cell: (row) => <MissedCell missed={row.missed} />,
    },
    effect,
    actionsColumn,
  ];
  const appliedColumns: readonly Column<RewriteRow>[] = [
    tool,
    {
      id: "applied",
      header: "Applied",
      align: "right",
      width: "6.5rem",
      className: "sm:min-w-24",
      hiddenBelow: "sm",
      cell: (row) =>
        row.appliedAt ? (
          <time
            dateTime={row.appliedAt}
            title={formatTimestamp(row.appliedAt)}
            className="whitespace-nowrap text-fg-muted"
          >
            {relativeTimeLabel(new Date(row.appliedAt), at)}
          </time>
        ) : null,
    },
    effect,
    actionsColumn,
  ];

  const pendingCount = toReview.length;
  return (
    <>
      {pending.length > 0 ? (
        <Section
          title={pendingCount > 0 ? `To review (${pendingCount})` : "To review"}
          actions={
            pendingCount > 0 ? (
              <>
                {overridesAdopted === true ? null : (
                  <span data-caveat="runtime" className="max-sm:hidden">
                    <StatusDot tone="warning" label="May not reach your agent yet" />
                  </span>
                )}
                {pendingCount > 1 ? (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={applyAll}
                    disabled={toReview.some((row) => busy.has(row.id))}
                  >
                    Apply all {pendingCount}
                  </Button>
                ) : null}
              </>
            ) : null
          }
        >
          <DataTable
            caption="Rewrites to review"
            columns={pendingColumns}
            rows={toReview}
            rowKey={(row) => row.id}
            selectedKey={open?.kind === "rewrite" ? open.row.id : null}
            onRowOpen={(row) => openRow(row)}
            empty={
              <EmptyState
                icon={CircleCheck}
                title="Nothing left to review"
                description="New rewrites appear after the next analysis."
              />
            }
          />
        </Section>
      ) : null}
      {live.length > 0 ? (
        <Section title={`Applied (${live.length})`}>
          <DataTable
            caption="Rewrites already applied"
            columns={appliedColumns}
            rows={live}
            rowKey={(row) => row.id}
            selectedKey={open?.kind === "rewrite" ? open.row.id : null}
            onRowOpen={(row) => openRow(row)}
          />
        </Section>
      ) : null}
      <Panel
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={
          showing ? (
            <PanelTitle
              name={
                showing.kind === "rewrite"
                  ? showing.row.toolName
                  : (toolCard?.name ?? showing.toolId)
              }
            />
          ) : (
            ""
          )
        }
        subtitle={showing ? panelSubtitle(showing, acted, at) : undefined}
        onPrevious={showing?.kind === "rewrite" ? () => step(-1) : undefined}
        onNext={showing?.kind === "rewrite" ? () => step(1) : undefined}
      >
        {showing?.kind === "rewrite" ? (
          <RewriteDetail
            projectId={projectId}
            row={showing.row}
            experimentName={experimentName}
            catalogHref={catalogEditHref(projectId, showing.row.toolName)}
            actions={actions(showing.row, "md")}
            caveat={overridesAdopted === true ? null : NOT_REACHING_RUNTIME}
          />
        ) : showing?.kind === "tool" && toolCard ? (
          <ToolCardDetail card={toolCard} windowPhrase={windowPhrase} />
        ) : null}
      </Panel>
    </>
  );
}

function PanelTitle({ name }: { name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <NounIcon noun="tool" />
      <span className="min-w-0 truncate font-mono">{name}</span>
    </span>
  );
}

function panelSubtitle(
  target: OpenTarget<RewriteRow>,
  acted: ReadonlyMap<string, Acted>,
  now: Date,
): string {
  if (target.kind === "tool") return "No rewrite yet";
  const row = target.row;
  if (row.status === "applied" || acted.get(row.id) === "applied") {
    return row.appliedAt ? `Applied ${relativeTimeLabel(new Date(row.appliedAt), now)}` : "Applied";
  }
  return `To review · ${row.change === "adds" ? "Adds wording" : "Rewrites"}`;
}

/** The searches it missed: a red mark and the count; the header says the word. */
function MissedCell({ missed }: { missed: number }) {
  if (missed === 0) return <span className="text-fg-subtle">0</span>;
  return (
    <span className="inline-flex items-center justify-end gap-1.5 tabular-nums">
      <SearchX aria-hidden strokeWidth={1.75} className="size-3.5 text-danger" />
      {missed.toLocaleString("en-US")}
    </span>
  );
}

/** The replay in a row: the pixels, then the change. */
function EffectCell({ row }: { row: RewriteRow }) {
  const effect = row.effect;
  if (!effect) return <span className="text-fg-subtle">Not replayed</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {effect.tool ? (
        <FoundMeter
          n={effect.tool.n}
          before={effect.tool.before}
          after={effect.tool.after}
          label={`Found in ${effect.tool.after} of ${effect.tool.n} past searches with the rewrite, ${effect.tool.before} without it`}
          className="max-sm:hidden"
        />
      ) : null}
      <EffectDelta effect={effect} />
    </span>
  );
}
