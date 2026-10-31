"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Disclosure } from "@ratel/design-system/disclosure";
import { DotSpark } from "@ratel/design-system/dot-matrix";
import { NounIcon, TaskPin, ToolPin } from "@ratel/design-system/entity";
import { ArrowUpRight, EyeOff, PenLine } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { dismissSlowSignalAction } from "@/app/(console)/project/[projectId]/health/signal-actions";
import { signalCaveat, splitFix } from "@/components/console/health/card-model";
import { groupFixLead, memberLabel, primaryOf } from "@/components/console/health/problem-groups";
import { storyDay } from "@/components/console/health/TurnStory";
import { type ExamplesCache, IssueExamples } from "@/components/console/health/v2/IssueExamples";
import { type IssueRow, memberNoun } from "@/components/console/health/v2/issue-rows";
import {
  clampFigures,
  figureCaption,
  formatCount,
  formatSharePercent,
} from "@/lib/readings/trace-signals/claims";
import { isDismissable } from "@/lib/readings/trace-signals/dismiss";
import type { SignalView, SubjectChip } from "@/lib/readings/trace-signals/view";
import { productWords } from "@/lib/views/fixes/copy";
import { DESCRIPTION_FIX_LABEL } from "@/lib/views/health/summary/fix-links";
import { capabilityCatalogHref } from "@/lib/views/intents/hrefs";

/**
 * An issue in its panel: what it is about (its tools and task as pins),
 * what to do and the fix that does it (a description update opens Quality
 * › Descriptions), the tools of a row of several (narrowed to one on a
 * click), why it matters, its example turns read on demand, and the numbers
 * behind it for whoever wants them. Engine sentences are told in the
 * product's nouns.
 */

const LINK =
  "rounded-sm text-fg underline decoration-line-strong underline-offset-2 outline-none hover:decoration-fg-muted focus-visible:ring-2 focus-visible:ring-focus";

export function IssueDetail({
  projectId,
  row,
  initialMemberId,
  examplesAllowed,
  upgradeHref,
  focusExamples,
  cache,
}: {
  projectId: string;
  row: IssueRow;
  /** A member the page was sent to (a link to one issue of the row); the row's worst opens on every tool. */
  initialMemberId: string | null;
  examplesAllowed: boolean;
  upgradeHref: string | null;
  /** Opened from "See turns": bring the examples into view. */
  focusExamples: boolean;
  cache: ExamplesCache;
}) {
  const { group } = row;
  const several = group.members.length > 1;
  const lead = primaryOf(group);
  const [picked, setPicked] = useState<string | null>(
    several && initialMemberId && initialMemberId !== lead.id ? initialMemberId : null,
  );
  const selected = picked
    ? (group.members.find((member) => member.id === picked) ?? null)
    : several
      ? null
      : lead;
  const shownMembers = selected ? [selected] : group.members;
  const fixes = selected
    ? row.fixes.filter((fix) => fix.issueIds.includes(selected.id))
    : row.fixes;
  const lede = productWords(groupFixLead(group, selected && several ? selected.id : null));
  const examplesRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focusExamples && examplesRef.current) scrollIntoPanel(examplesRef.current);
  }, [focusExamples]);

  return (
    <div className="flex flex-col gap-6" data-issue-detail={row.kind}>
      <Subject projectId={projectId} row={row} member={several ? selected : lead} />
      <section aria-label="What to do" className="flex flex-col gap-3">
        <p className="text-sm text-fg">{lede}</p>
        {fixes.length > 0 ? (
          <FixLinks fixes={fixes} />
        ) : (
          <p className="text-xs text-fg-subtle">No fix drafted for this yet.</p>
        )}
        {selected && isDismissable(selected.kind) ? (
          <HideSlow projectId={projectId} signal={selected} />
        ) : null}
      </section>

      {several ? (
        <Members
          members={group.members}
          task={row.task}
          selectedId={selected?.id ?? null}
          onPick={setPicked}
        />
      ) : null}

      <section aria-labelledby={`${row.key}-why`} className="flex flex-col gap-1.5">
        <h3 id={`${row.key}-why`} className="text-sm font-semibold text-fg">
          Why it matters
        </h3>
        <p className="text-ui text-fg">
          <Claim projectId={projectId} signal={selected ?? lead} />
        </p>
        <p className="text-ui text-fg-muted">
          {productWords(clampFigures((selected ?? lead).cost))}
        </p>
        {!selected ? (
          <p className="text-xs text-fg-subtle">
            The worst of {group.members.length} {memberNoun(group.members, group.members.length)}.
            Pick one above for its own.
          </p>
        ) : null}
      </section>

      <section
        ref={examplesRef}
        aria-labelledby={`${row.key}-examples`}
        className="flex scroll-mt-4 flex-col gap-2"
      >
        <h3 id={`${row.key}-examples`} className="text-sm font-semibold text-fg">
          Example turns
        </h3>
        <IssueExamples
          projectId={projectId}
          members={shownMembers}
          labelTools={shownMembers.length > 1}
          examplesAllowed={examplesAllowed}
          upgradeHref={upgradeHref}
          cache={cache}
        />
      </section>

      <Numbers
        signal={selected ?? lead}
        worstOf={
          selected
            ? null
            : `${group.members.length} ${memberNoun(group.members, group.members.length)}`
        }
      />
    </div>
  );
}

/**
 * Brings a part of the panel to the top of the panel's own scrolling body.
 * `scrollIntoView` would also move the panel's clipped frame and hide its
 * header, so only the nearest scrolling ancestor moves.
 */
function scrollIntoPanel(element: HTMLElement): void {
  let scroller = element.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
    scroller = scroller.parentElement;
  if (!scroller) return;
  const top =
    element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTo({ top: Math.max(0, top - 16) });
}

/**
 * What the issue is about, as pins: the tools of the member in view (each
 * opening on Catalog), else nothing (the member list names them), and the
 * task it is about. An issue about no tool names its scope.
 */
function Subject({
  projectId,
  row,
  member,
}: {
  projectId: string;
  row: IssueRow;
  member: SignalView | null;
}) {
  const chips = member ? member.subject.chips.filter((chip) => chip.label.length > 0) : [];
  const scope = member && chips.length === 0 ? row.scope : null;
  if (chips.length === 0 && !row.task && !scope) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-issue-subject="">
      {chips.map((chip) => (
        <ToolPin
          key={chip.id}
          name={chip.label}
          kind={chip.entryKind === "skill" ? "skill" : "tool"}
          href={
            chip.entryKind === "tool"
              ? capabilityCatalogHref(projectId, "tool", chip.id)
              : capabilityCatalogHref(projectId, "skill", chip.label, chip.id)
          }
        />
      ))}
      {scope ? <span className="text-ui text-fg-muted">{scope}</span> : null}
      {row.task ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {chips.length > 0 || scope ? (
            <span className="text-xs text-fg-subtle">in</span>
          ) : (
            <NounIcon noun="task" />
          )}
          <TaskPin name={row.task.name} slot={row.task.color} href={row.task.href} />
        </span>
      ) : null}
    </div>
  );
}

function FixLinks({ fixes }: { fixes: IssueRow["fixes"] }) {
  if (fixes.length === 1) {
    const [fix] = fixes;
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-ui text-fg-muted">
          {fix!.applied ? "Applied: " : "The fix: "}
          <span className="text-fg">{fix!.title}</span>
        </p>
        <Link
          href={fix!.href}
          className={buttonVariants({
            variant: fix!.applied ? "secondary" : "primary",
            size: "sm",
          })}
          data-issue-fix={fix!.id}
          data-issue-fix-kind={fix!.description ? "description" : "fix"}
        >
          {fix!.description ? <PenLine aria-hidden /> : null}
          {fix!.description ? DESCRIPTION_FIX_LABEL : "Open fix"}
          {fix!.description ? null : <ArrowUpRight aria-hidden />}
        </Link>
      </div>
    );
  }
  return (
    <ul className="flex flex-col" aria-label="Fixes">
      {fixes.map((fix) => (
        <li key={fix.id} className="border-b border-line last:border-b-0">
          <Link
            href={fix.href}
            className="group flex min-h-9 items-center gap-2 py-1.5 text-ui outline-none focus-visible:ring-2 focus-visible:ring-focus"
            data-issue-fix={fix.id}
            data-issue-fix-kind={fix.description ? "description" : "fix"}
          >
            {fix.description ? (
              <PenLine aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-fg group-hover:underline">
              {fix.title}
            </span>
            {fix.applied ? <span className="text-xs text-success">Applied</span> : null}
            <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** "Slow by design, hide it": a slow tool whose work takes this long. Back with "Show again" under the list. */
function HideSlow({ projectId, signal }: { projectId: string; signal: SignalView }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const tool = signal.subject.chips[0]?.label ?? signal.subject.label;
  return (
    <div className="flex flex-wrap items-center gap-2" data-slow-by-design={signal.id}>
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const result = await dismissSlowSignalAction(projectId, signal.id);
            if (!result.ok) setError(result.message);
          })
        }
      >
        <EyeOff aria-hidden />
        {pending ? "Hiding…" : "Hide: slow by design"}
      </Button>
      <span
        role={error ? "alert" : undefined}
        className={cn("text-xs", error ? "text-danger" : "text-fg-subtle")}
      >
        {error ?? `For tools like ${tool} whose work takes this long.`}
      </span>
    </div>
  );
}

/** Every tool of the row, with its own number; one picked narrows the panel to it. */
function Members({
  members,
  task,
  selectedId,
  onPick,
}: {
  members: readonly SignalView[];
  /** The row's task, so a member raised on it wears its color. */
  task: IssueRow["task"];
  selectedId: string | null;
  onPick: (id: string | null) => void;
}) {
  const item = (active: boolean) =>
    cn(
      "flex min-h-8 w-full items-center gap-3 rounded-md px-2 py-1 text-left text-ui outline-none transition-colors duration-120 focus-visible:ring-2 focus-visible:ring-focus",
      active ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
    );
  return (
    <section aria-label="Tools" className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold text-fg">Tools</h3>
      <ul className="flex flex-col">
        <li>
          <button
            type="button"
            aria-pressed={selectedId === null}
            onClick={() => onPick(null)}
            className={item(selectedId === null)}
          >
            <span className="min-w-0 flex-1">
              All {members.length} {memberNoun(members, members.length)}
            </span>
          </button>
        </li>
        {members.map((member) => (
          <li key={member.id}>
            <button
              type="button"
              aria-pressed={selectedId === member.id}
              onClick={() => onPick(member.id)}
              className={item(selectedId === member.id)}
            >
              <MemberPins member={member} task={task} />
              <span className="shrink-0 text-xs tabular-nums">
                {clampFigures(member.figure.display)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Pins a member shows before its label counts the rest ("a + 4 more"). */
const SUBJECT_PINS = 3;

/** A member's tools as pins (a pair is two), its task's pin when it is raised on a task, or its own label. */
function MemberPins({ member, task }: { member: SignalView; task: IssueRow["task"] }) {
  if (member.subject.kind === "workflow") {
    const own = task?.id === member.subject.key ? task : null;
    return (
      <span className="flex min-w-0 flex-1">
        <TaskPin name={own?.name ?? member.subject.label} slot={own?.color ?? null} />
      </span>
    );
  }
  const chips = member.subject.chips.filter((chip) => chip.label.length > 0);
  if (chips.length === 0 || chips.length > SUBJECT_PINS)
    return <span className="min-w-0 flex-1 truncate font-mono text-xs">{memberLabel(member)}</span>;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      {chips.map((chip, index) => (
        <span key={`${chip.id}-${index}`} className="flex min-w-0 shrink items-center gap-1">
          {index > 0 ? (
            <span aria-hidden className="shrink-0 text-fg-faint">
              +
            </span>
          ) : null}
          <ToolPin name={chip.label} kind={chip.entryKind === "skill" ? "skill" : "tool"} />
        </span>
      ))}
    </span>
  );
}

/** The claim, with each tool it names opening the tool on Catalog. */
function Claim({ projectId, signal }: { projectId: string; signal: SignalView }) {
  const chips = new Map(signal.subject.chips.map((chip) => [chip.id, chip]));
  return (
    <>
      {signal.claimSegments.map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index}>{productWords(clampFigures(segment.text))}</span>
        ) : (
          <ToolLink
            key={index}
            projectId={projectId}
            chip={
              chips.get(segment.chipId) ?? {
                id: segment.chipId,
                label: segment.text,
                entryKind: "tool",
              }
            }
            text={segment.text}
          />
        ),
      )}
    </>
  );
}

function ToolLink({
  projectId,
  chip,
  text,
}: {
  projectId: string;
  chip: SubjectChip;
  text: string;
}) {
  const href =
    chip.entryKind === "tool"
      ? capabilityCatalogHref(projectId, "tool", chip.id)
      : capabilityCatalogHref(projectId, "skill", chip.label, chip.id);
  return (
    <Link href={href} className={cn(LINK, "font-mono text-xs")} data-subject-chip={chip.id}>
      {text}
    </Link>
  );
}

const DECIDED_BY: Readonly<Record<SignalView["tier"], string>> = {
  deterministic: "Counted from your traces",
  classifier: "Scored by a classifier",
  judge: "Judged",
};

/** The numbers behind the issue, behind "Details" (DESIGN.md, Principles 2 and 3). */
function Numbers({ signal, worstOf }: { signal: SignalView; worstOf: string | null }) {
  const caveat = signalCaveat(signal);
  const range =
    signal.interval && signal.figure.unit === "share"
      ? `${formatSharePercent(signal.interval.low)} to ${formatSharePercent(signal.interval.high)}`
      : null;
  const first = storyDay(signal.firstSeenAt);
  const last = storyDay(signal.lastSeenAt);
  const found = first && last ? (first === last ? first : `${first} to ${last}`) : null;
  const rest = splitFix(signal.fix).rest;
  const chart = signal.evidence.chart;
  return (
    <Disclosure title="Details" hint={worstOf ? `the worst of ${worstOf}` : undefined}>
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-ui">
          <dt className="text-fg-subtle">Measured</dt>
          <dd className="text-fg tabular-nums">
            {clampFigures(signal.figure.display)} {figureCaption(signal.kind, signal.figure)}
            <span className="text-fg-subtle"> · {clampFigures(signal.figure.raw)}</span>
          </dd>
          {range ? (
            <>
              <dt className="text-fg-subtle">Likely between</dt>
              <dd className="text-fg tabular-nums">{range}</dd>
            </>
          ) : null}
          <dt className="text-fg-subtle">How we know</dt>
          <dd className="text-fg">{DECIDED_BY[signal.tier]}</dd>
          {found ? (
            <>
              <dt className="text-fg-subtle">Seen</dt>
              <dd className="text-fg">{found}</dd>
            </>
          ) : null}
          {signal.evidence.totalTurns > 0 ? (
            <>
              <dt className="text-fg-subtle">Turns</dt>
              <dd className="text-fg tabular-nums">{formatCount(signal.evidence.totalTurns)}</dd>
            </>
          ) : null}
        </dl>
        {chart?.kind === "sparkline" && chart.points.some((point) => point.value !== null) ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-fg-subtle">Day by day</p>
            <DotSpark values={chart.points.map((point) => point.value)} label="Day by day" />
          </div>
        ) : null}
        {chart?.kind === "rank_histogram" ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-fg-subtle">By position in the list</p>
            <dl className="grid grid-cols-4 gap-2 text-ui">
              {chart.bands.map((band) => (
                <div key={band.label} className="flex flex-col">
                  <dt className="text-xs text-fg-subtle">{band.label}</dt>
                  <dd className="text-fg tabular-nums">{formatCount(band.count)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
        {rest ? (
          <p className="text-ui text-fg-muted">{productWords(clampFigures(signal.fix))}</p>
        ) : null}
        {caveat ? <p className="text-xs text-fg-subtle">Note: {productWords(caveat)}</p> : null}
      </div>
    </Disclosure>
  );
}
