"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { FilterBar, FilterChip } from "@ratel/design-system/filter-bar";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { stepIndex } from "@ratel/design-system/peek";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { ArrowUpRight, CircleCheck, SearchX } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState, useTransition } from "react";
import { dismissDraftedFixAction } from "@/app/(console)/project/[projectId]/improvement/fixes/actions";
import { EvalBadgeValue } from "@/components/console/eval-gate/EvalBadge";
import { EvalGateSection } from "@/components/console/eval-gate/EvalGateSection";
import { formatTimestamp } from "@/lib/synthesis/traces/format";
import { changeOf } from "@/lib/views/eval-gate/change";
import { nothingToSimulate } from "@/lib/views/eval-gate/method";
import type { EvalBadge } from "@/lib/views/eval-gate/types";
import { evalHref } from "@/lib/views/eval-gate/view";
import { type Acted, withActed } from "@/lib/views/fixes/acted";
import {
  FIX_GROUP_LINES,
  FIX_GROUP_TITLES,
  FIX_GROUPS,
  type FixGroup,
  groupAnchor,
} from "@/lib/views/fixes/groups";
import { descriptionHref, type FixFilters, hasFilters } from "@/lib/views/fixes/href";
import { FIX_KIND_LABELS, FIX_KINDS, type FixKind } from "@/lib/views/fixes/kinds";
import { filterFixes, findFix } from "@/lib/views/fixes/select";
import { type FixShipped, shippedFor, shippedLabel } from "@/lib/views/fixes/shipped";
import type { Fix, FixesModel } from "@/lib/views/fixes/types";
import { relativeTimeLabel } from "@/lib/views/intents/adaptive-view";
import { settle } from "@/lib/views/quality/suggestions";
import { CopyChangeButton } from "./CopyChangeButton";
import { AffectsPins } from "./FixAffects";
import { EffectValue, EvidenceValue, FixTitleCell } from "./FixCells";
import { FixDetail } from "./FixDetail";
import { FIX_GROUP_ICONS } from "./kind-icons";
import { useFixFilters } from "./url";

/** The value the "everything" option carries; the URL leaves the filter out. */
const ALL = "all";

/** What a row's one action says, per table: the same on every row of it. */
const ROW_ACTION: Readonly<Record<FixGroup, string>> = {
  descriptions: "Update description",
  tools: "Copy prompt",
  skills: "Copy prompt",
  ranking: "Copy prompt",
};

/**
 * The fixes as tables by what you do (DESIGN.md, Lists): descriptions to
 * update (on Quality › Descriptions, where Apply lives), changes to your
 * tools, skills to add and ranking settings, each biggest effect first. A
 * row is its kind's mark, the verb-first title, what it touches as pins, one
 * effect, the evidence and one action, the same on every row of its table.
 * Filters (kind and task as menus, tool and intent as chips) and the open
 * fix (`?peek=`) live in the URL.
 */
export function FixesList({
  model,
  now,
  evalBadges = null,
  shipped = null,
  taskSimulations = false,
}: {
  model: FixesModel;
  now: string;
  /** Each fix's eval gate, by fix id; null when `cloud-eval-gate` is off (no column, no section). */
  evalBadges?: Readonly<Record<string, EvalBadge>> | null;
  /** Each shipped fix's newest shipment, by fix id (RC-72); null when `cloud-stage-spine` is off. */
  shipped?: Readonly<Record<string, FixShipped>> | null;
  taskSimulations?: boolean;
}) {
  const router = useRouter();
  const peek = usePeek();
  const [filters, setFilters, hrefWith] = useFixFilters();
  const [, startTransition] = useTransition();
  const [acted, setActed] = useState<ReadonlyMap<string, Acted>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [lastId, setLastId] = useState<string | null>(null);
  const at = useMemo(() => new Date(now), [now]);

  const lists = useMemo(() => withActed(model, acted, new Date().toISOString()), [model, acted]);
  const open = filterFixes(lists.open, filters);
  const applied = filterFixes(lists.applied, filters);
  const sections = FIX_GROUPS.map((group) => ({
    group,
    fixes: open.filter((fix) => fix.group === group),
  })).filter(
    (section) =>
      section.fixes.length > 0 || (section.group === "descriptions" && applied.length > 0),
  );
  const ordered = sections.flatMap((section) => section.fixes);
  const current = findFix([...lists.open, ...lists.applied], peek.id);
  const showing = current ?? findFix([...model.open, ...model.applied], lastId);

  const openRow = (id: string) => {
    setLastId(id);
    peek.open(id);
  };
  const step = (direction: 1 | -1) => {
    const index = current ? ordered.findIndex((fix) => fix.id === current.id) : -1;
    const next = ordered[stepIndex(index, direction, ordered.length)];
    if (next) openRow(next.id);
  };

  const mark = (id: string, state: Acted | null) =>
    setActed((previous) => {
      const next = new Map(previous);
      if (state === null) next.delete(id);
      else next.set(id, state);
      return next;
    });
  const setBusyRow = (id: string, on: boolean) =>
    setBusy((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Dismiss a drafted change: the row leaves at once and comes back, with the reason, if the server says no. */
  const dismiss = (fix: Fix) => {
    const before = acted.get(fix.id) ?? null;
    setBusyRow(fix.id, true);
    // Its panel closes with it rather than waiting on a fix that is gone.
    if (current?.id === fix.id) peek.close();
    mark(fix.id, "dismissed");
    startTransition(async () => {
      const outcome = await settle(() => dismissDraftedFixAction(model.projectId, fix.sourceId));
      setBusyRow(fix.id, false);
      if (!outcome.ok) {
        mark(fix.id, before);
        toast({ title: "Couldn't dismiss the fix", description: outcome.message, tone: "danger" });
        return;
      }
      toast({
        title: "Fix dismissed",
        description: "Later readings won't draft this change again.",
      });
      router.refresh();
    });
  };

  /** The one action a row shows: the same for every row of its table. */
  const rowAction = (fix: Fix) => {
    if (fix.group === "descriptions") {
      return (
        <Link
          href={fix.actions.descriptionHref ?? descriptionHref(model.projectId)}
          prefetch={false}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          {ROW_ACTION.descriptions}
          <ArrowUpRight aria-hidden className="size-3.5" />
        </Link>
      );
    }
    return fix.actions.copy ? (
      <CopyChangeButton
        text={fix.actions.copy.text}
        label={ROW_ACTION[fix.group]}
        size="sm"
        variant="ghost"
      />
    ) : null;
  };

  /** The Panel's actions: the row's, as the primary one, and Dismiss where the fix can be dismissed. */
  const panelActions = (fix: Fix): ReactNode => {
    if (fix.status === "applied") {
      return (
        <>
          {fix.appliedAt ? (
            <span className="text-ui text-fg-muted">
              Applied{" "}
              <time dateTime={fix.appliedAt} title={formatTimestamp(fix.appliedAt)}>
                {relativeTimeLabel(new Date(fix.appliedAt), at)}
              </time>
            </span>
          ) : null}
          <Link
            href={fix.actions.descriptionHref ?? descriptionHref(model.projectId)}
            className={buttonVariants({ variant: "secondary", size: "md" })}
          >
            Open on Quality
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        </>
      );
    }
    // A rewrite is dismissed where it is applied, on Quality; a drafted change here.
    const dismissable = fix.actions.dismiss && fix.source === "craft";
    const dismissButton = dismissable ? (
      <Button size="md" variant="ghost" disabled={busy.has(fix.id)} onClick={() => dismiss(fix)}>
        Dismiss
      </Button>
    ) : null;
    if (fix.group === "descriptions") {
      return (
        <>
          <Link
            href={fix.actions.descriptionHref ?? descriptionHref(model.projectId)}
            className={buttonVariants({ variant: "primary", size: "md" })}
          >
            {ROW_ACTION.descriptions}
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
          {dismissButton}
        </>
      );
    }
    return (
      <>
        {fix.actions.copy ? (
          <CopyChangeButton
            text={fix.actions.copy.text}
            label={ROW_ACTION[fix.group]}
            size="md"
            variant="primary"
          />
        ) : null}
        {dismissButton}
      </>
    );
  };

  const onFilter = (param: keyof FixFilters, value: string) => setFilters({ [param]: value });
  const pins = (fix: Fix) => (
    <AffectsPins
      subject={fix.subject}
      hrefFor={(param, value) => hrefWith({ [param]: value })}
      onFilter={onFilter}
    />
  );
  // The title is short and the pins carry the names, so from xl the pins get the room. Narrower
  // (the rail takes 240 px from md) the pins sit under the title, so equal titles stay apart.
  const columns: readonly Column<Fix>[] = [
    {
      id: "fix",
      header: "Fix",
      // min-width beats max-width: the title keeps its room and still truncates inside it.
      className: "max-w-0 max-xl:w-full xl:min-w-72",
      cell: (fix) => (
        <span className="flex min-w-0 flex-col gap-1.5 max-xl:py-2">
          <ShippedTitle fix={fix} shipped={shippedFor(shipped, fix)} />
          <span className="flex min-w-0 pl-6.5 xl:hidden">{pins(fix)}</span>
          <span className="pl-6.5 sm:hidden">
            <EffectValue effect={fix.effect} gain={fix.gain} />
          </span>
        </span>
      ),
    },
    {
      id: "affects",
      header: "Affects",
      className: "w-full max-w-0 max-xl:hidden",
      headerClassName: "max-xl:hidden",
      cell: (fix) => pins(fix),
    },
    // Fixed widths (min-width, which the full-width pins column cannot squeeze), so every table lines up.
    {
      id: "effect",
      header: "Effect",
      hiddenBelow: "sm",
      className: "max-w-64 min-w-52 py-2",
      cell: (fix) => <EffectValue effect={fix.effect} gain={fix.gain} />,
    },
    {
      id: "evidence",
      header: "Evidence",
      hiddenBelow: "lg",
      className: "min-w-24",
      cell: (fix) => <EvidenceValue evidence={fix.evidence} />,
    },
    ...(evalBadges
      ? [
          {
            id: "eval",
            header: "Eval",
            hiddenBelow: "lg",
            className: "min-w-40",
            cell: (fix) => (
              <EvalBadgeValue badge={evalBadges[fix.id]} href={evalHref(model.projectId, fix.id)} />
            ),
          } satisfies Column<Fix>,
        ]
      : []),
    {
      id: "action",
      header: <span className="sr-only">Action</span>,
      align: "right",
      className: "min-w-46",
      // On a phone the row opens the Panel, where the same action leads.
      hiddenBelow: "sm",
      cell: (fix) => <span className="flex justify-end">{rowAction(fix)}</span>,
    },
  ];

  const filtered = hasFilters(filters);
  const total = lists.open.length;
  const pendingRewrites = lists.open.some((fix) => fix.source === "rewrite");
  return (
    <>
      <Filters
        model={model}
        lists={lists}
        filters={filters}
        setFilters={setFilters}
        shown={open.length}
        total={total}
      />
      {sections.length === 0 ? (
        <div className="rounded-lg border border-line">
          {filtered ? (
            <EmptyState
              icon={SearchX}
              title="No fixes match"
              description="Clear the filters to see every fix."
              action={
                <Button
                  variant="secondary"
                  onClick={() => setFilters({ kind: null, task: null, tool: null, topic: null })}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={CircleCheck}
              title="Nothing left to fix"
              description="New fixes appear after the next reading of your agent's runs."
            />
          )}
        </div>
      ) : (
        sections.map(({ group, fixes }) => (
          <div key={group} id={groupAnchor(group)} className="scroll-mt-6" data-fix-group={group}>
            <GroupSection
              group={group}
              count={fixes.length}
              aside={
                group === "descriptions" ? (
                  <DescriptionsAside
                    applied={applied.length}
                    appliedHref={descriptionHref(model.projectId)}
                    caveat={pendingRewrites && model.overridesAdopted !== true}
                  />
                ) : null
              }
            >
              {fixes.length > 0 ? (
                <DataTable
                  caption={`${FIX_GROUP_TITLES[group]}, biggest effect first`}
                  columns={columns}
                  rows={fixes}
                  rowKey={(fix) => fix.id}
                  selectedKey={current?.id ?? null}
                  onRowOpen={(fix) => openRow(fix.id)}
                />
              ) : (
                <div className="rounded-lg border border-line">
                  <EmptyState
                    icon={CircleCheck}
                    title="Every description is up to date"
                    description="The rewrites you applied are on Quality."
                  />
                </div>
              )}
            </GroupSection>
          </div>
        ))
      )}
      <Panel
        open={current !== null}
        onOpenChange={(next) => {
          if (!next) peek.close();
        }}
        title={showing?.short ?? ""}
        subtitle={showing ? subtitleOf(showing, shippedFor(shipped, showing)) : undefined}
        onPrevious={() => step(-1)}
        onNext={() => step(1)}
      >
        {showing ? (
          <FixDetail
            key={showing.id}
            fix={showing}
            actions={panelActions(showing)}
            projectId={model.projectId}
            shipped={shippedFor(shipped, showing)}
            gate={
              evalBadges ? (
                <>
                  {taskSimulations && showing.subject.tasks.length > 0 ? (
                    <div className="flex flex-col gap-2 py-3">
                      <p className="text-sm font-semibold text-fg">Task simulations</p>
                      {showing.subject.tasks.map((task) => (
                        <Link
                          key={task.id}
                          href={`/project/${encodeURIComponent(model.projectId)}/tasks/${encodeURIComponent(task.id)}/simulations/${encodeURIComponent(showing.id)}`}
                          className="rounded-md text-ui text-fg-muted outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          Simulate on {task.label}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                  <EvalGateSection
                    projectId={model.projectId}
                    fixId={showing.id}
                    badge={evalBadges[showing.id]}
                    blocked={
                      showing.kind === "rewrite" || showing.kind === "tell-apart"
                        ? null
                        : nothingToSimulate(showing.kind, changeOf(showing))
                    }
                  />
                </>
              ) : null
            }
          />
        ) : null}
      </Panel>
    </>
  );
}

/** A table's heading: its group's mark, what you do there, how many, and one line. */
function GroupSection({
  group,
  count,
  aside,
  children,
}: {
  group: FixGroup;
  count: number;
  aside: ReactNode;
  children: ReactNode;
}) {
  const Icon = FIX_GROUP_ICONS[group];
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <Icon aria-hidden strokeWidth={1.5} className="size-4 text-fg-muted" />
          {FIX_GROUP_TITLES[group]}
          <span className="font-normal text-fg-subtle tabular-nums">{count}</span>
        </span>
      }
      description={FIX_GROUP_LINES[group]}
      actions={aside}
    >
      {children}
    </Section>
  );
}

/** Beside the descriptions' heading: where the applied ones are, and whether a rewrite reaches the agent yet. */
function DescriptionsAside({
  applied,
  appliedHref,
  caveat,
}: {
  applied: number;
  appliedHref: string;
  caveat: boolean;
}) {
  if (applied === 0 && !caveat) return null;
  return (
    <>
      {caveat ? (
        // Said in full beside the rewrite in its panel.
        <span data-caveat="runtime">
          <StatusDot tone="warning" label="May not reach your agent yet" className="text-xs" />
        </span>
      ) : null}
      {applied > 0 ? (
        <Link
          href={appliedHref}
          className="inline-flex items-center gap-1 rounded-md text-xs text-fg-muted tabular-nums outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          {applied} applied
          <ArrowUpRight aria-hidden className="size-3" />
        </Link>
      ) : null}
    </>
  );
}

function subtitleOf(fix: Fix, shipped: FixShipped | null): string {
  return [
    FIX_GROUP_TITLES[fix.group],
    fix.kindLabel,
    fix.status === "applied" ? "Applied" : null,
    shipped ? shippedLabel(shipped) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The title, and "Shipped in v2.5.0" beside it once `mark_fix_shipped` recorded it (RC-72); unshipped, the title alone, as before. */
function ShippedTitle({ fix, shipped }: { fix: Fix; shipped: FixShipped | null }) {
  if (!shipped) return <FixTitleCell fix={fix} />;
  return (
    <span className="flex min-w-0 items-center gap-3">
      <FixTitleCell fix={fix} />
      <span className="shrink-0" data-fix-shipped={shipped.version}>
        <StatusDot tone="success" label={shippedLabel(shipped)} className="text-xs" />
      </span>
    </span>
  );
}

/** Kind and task as menus, tool and intent as chips, and how many are listed. */
function Filters({
  model,
  lists,
  filters,
  setFilters,
  shown,
  total,
}: {
  model: FixesModel;
  lists: { open: Fix[]; applied: Fix[] };
  filters: FixFilters;
  setFilters: (changes: Partial<Record<keyof FixFilters, string | null>>) => void;
  shown: number;
  total: number;
}) {
  const everything = [...lists.open, ...lists.applied, ...model.open, ...model.applied];
  const kinds = FIX_KINDS.filter(
    (kind) => kind === filters.kind || everything.some((fix) => fix.kind === kind),
  );
  const tasks = new Map<string, string>();
  const tools = new Map<string, string>();
  const intents = new Map<string, string>();
  for (const fix of everything) {
    for (const task of fix.subject.tasks) tasks.set(task.id, task.label);
    for (const tool of fix.subject.tools) tools.set(tool.id, tool.label);
    for (const topic of fix.subject.topics) intents.set(topic.id, topic.label);
  }
  if (filters.task && !tasks.has(filters.task)) tasks.set(filters.task, filters.task);
  const taskOptions = [...tasks].sort((a, b) => a[1].localeCompare(b[1]));
  return (
    <FilterBar
      search={
        <Select
          aria-label="Kind of fix"
          options={[
            { value: ALL, label: "All kinds" },
            ...kinds.map((kind: FixKind) => ({ value: kind, label: FIX_KIND_LABELS[kind] })),
          ]}
          value={filters.kind ?? ALL}
          onValueChange={(value) => setFilters({ kind: value === ALL ? null : value })}
          className="w-52"
        />
      }
      chips={
        <>
          {taskOptions.length > 0 ? (
            <Select
              aria-label="Task"
              options={[
                { value: ALL, label: "All tasks" },
                ...taskOptions.map(([id, label]) => ({ value: id, label })),
              ]}
              value={filters.task ?? ALL}
              onValueChange={(value) => setFilters({ task: value === ALL ? null : value })}
              className="w-52"
            />
          ) : null}
          {filters.tool ? (
            <FilterChip
              field="Tool"
              value={
                <span className="font-mono text-xs">{tools.get(filters.tool) ?? filters.tool}</span>
              }
              onRemove={() => setFilters({ tool: null })}
            />
          ) : null}
          {filters.topic ? (
            <FilterChip
              field="Intent"
              value={intents.get(filters.topic) ?? filters.topic}
              onRemove={() => setFilters({ topic: null })}
            />
          ) : null}
        </>
      }
      end={
        <span className="text-xs text-fg-subtle tabular-nums">
          {hasFilters(filters)
            ? `${shown} of ${total} open ${total === 1 ? "fix" : "fixes"}`
            : `${total} open ${total === 1 ? "fix" : "fixes"}`}
        </span>
      }
    />
  );
}
