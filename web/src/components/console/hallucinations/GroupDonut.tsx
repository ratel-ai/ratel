"use client";

import { cn } from "@ratel/design-system/cn";
import { Tooltip } from "@ratel/design-system/tooltip";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { GROUP_COLOR, GROUP_SHORT, GROUP_STROKE } from "@/components/console/hallucinations/copy";
import { RING_SIZE, RingArc, RingTrack, ringArcs } from "@/components/console/health/v2/ring";
import { percent, plural } from "@/components/console/sentiment/copy";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { HallucinationGroup } from "@/lib/readings/trace-signals/hallucinations/kinds";
import type {
  GroupView,
  HallucinationsLinks,
  KindView,
} from "@/lib/views/health/hallucinations/page-links";

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-focus";

/**
 * The groups as a ring: each group's slice is its share of every
 * hallucination in the window, with the total in the middle. Pointing at a
 * slice (or at its row) puts that group's share in the middle instead.
 * Beside the ring, the same groups as a list with their occurrences and
 * share. A slice or a row narrows the table below to its group and opens the
 * group's kinds to the right of its row; a kind narrows the table to itself.
 * Picking the active one again lets go, as does "All groups".
 */
export function GroupDonut({ links, total }: { links: HallucinationsLinks; total: number }) {
  const slices = ringArcs(
    links.groups.filter((group) => group.occurrences > 0),
    (group) => (total === 0 ? 0 : group.occurrences / total),
  ).map(({ slice, length, offset }) => ({ group: slice, length, offset }));
  const picked = links.activeGroup !== null;
  const [pointed, setPointed] = useState<HallucinationGroup | null>(null);
  // The group whose kinds are open follows the address. A click opens or
  // closes at once, ahead of the page it leads to, and gives way once the
  // address has changed.
  const address = `${links.activeGroup ?? ""}:${links.activeKind ?? ""}`;
  const [ahead, setAhead] = useState<{ address: string; open: HallucinationGroup | null } | null>(
    null,
  );
  const open = ahead && ahead.address === address ? ahead.open : links.activeGroup;
  const pick = (group: GroupView) =>
    setAhead({ address, open: group.staysPicked ? group.group : null });
  const point = (group: HallucinationGroup) => ({
    onMouseEnter: () => setPointed(group),
    onMouseLeave: () => setPointed(null),
    onFocus: () => setPointed(group),
    onBlur: () => setPointed(null),
  });
  const shown =
    links.groups.find((group) => group.group === pointed && group.occurrences > 0) ?? null;
  return (
    <div className="@container flex flex-col gap-4" data-hallucination-groups="">
      <nav
        aria-label="Group"
        className="inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-md border border-line bg-app p-0.5"
      >
        {[
          { key: "all", label: "All groups", href: links.allHref, active: !picked, count: total },
          ...links.groups.map((group) => ({
            key: group.group,
            label: group.label,
            href: group.href,
            active: group.active,
            count: group.occurrences,
          })),
        ].map((choice) => (
          <Link
            key={choice.key}
            href={choice.href}
            scroll={false}
            aria-current={choice.active ? "true" : undefined}
            onClick={() => setAhead(null)}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-[4px] px-2 text-ui font-medium whitespace-nowrap transition-colors duration-120",
              FOCUS,
              choice.active ? "bg-selected text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {choice.label}
            <span className="text-xs text-fg-subtle tabular-nums">{formatCount(choice.count)}</span>
          </Link>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-x-10 gap-y-6">
        <div className="relative size-44 shrink-0" data-hallucination-donut="">
          <svg
            viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
            className="size-full -rotate-90 overflow-visible"
            role="img"
            aria-label={`Hallucinations by group: ${slices.map(({ group }) => `${group.label} ${percent(group.share)}`).join(", ")}`}
          >
            <RingTrack />
            {slices.map(({ group, length, offset }) => (
              <Link
                key={group.group}
                href={group.href}
                scroll={false}
                aria-label={`${group.label}: ${formatCount(group.occurrences)}, ${percent(group.share)}`}
                onClick={() => pick(group)}
                className={cn("rounded-sm", FOCUS)}
                data-hallucination-slice={group.group}
                {...point(group.group)}
              >
                <RingArc
                  length={length}
                  offset={offset}
                  pointed={shown?.group === group.group}
                  className={cn(
                    "cursor-pointer",
                    GROUP_STROKE[group.group],
                    shown
                      ? shown.group !== group.group && "opacity-35"
                      : picked && !group.active && "opacity-25",
                  )}
                />
              </Link>
            ))}
          </svg>
          <div
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
            aria-live="polite"
            data-hallucination-donut-middle=""
          >
            {shown ? (
              <>
                <span className="text-2xl font-semibold text-fg tabular-nums">
                  {percent(shown.share)}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                  <span
                    aria-hidden
                    className={cn("size-2 shrink-0 rounded-[2px]", GROUP_COLOR[shown.group])}
                  />
                  {GROUP_SHORT[shown.group]}
                </span>
                <span className="text-xs text-fg-subtle tabular-nums">{`${formatCount(shown.occurrences)} of ${formatCount(total)}`}</span>
              </>
            ) : (
              <>
                <span className="text-2xl font-semibold text-fg tabular-nums">
                  {formatCount(total)}
                </span>
                <span className="text-xs text-fg-subtle">
                  {total === 1 ? "hallucination" : "hallucinations"}
                </span>
              </>
            )}
          </div>
        </div>
        <ul aria-label="Groups" className="flex min-w-[16rem] flex-1 flex-col gap-1">
          {links.groups.map((group) => {
            const isOpen = open === group.group && group.kinds.length > 0;
            return (
              <li
                key={group.group}
                className="flex flex-col gap-1 @5xl:flex-row @5xl:items-center @5xl:gap-0"
              >
                <div className="w-full max-w-md @5xl:w-[24rem] @5xl:shrink-0">
                  <Tooltip content={group.meaning}>
                    {group.kinds.length > 0 ? (
                      <Link
                        href={group.href}
                        scroll={false}
                        aria-current={group.active ? "true" : undefined}
                        aria-expanded={isOpen}
                        onClick={() => pick(group)}
                        className={cn(
                          ROW,
                          FOCUS,
                          isOpen || group.active
                            ? "bg-selected"
                            : pointed === group.group
                              ? "bg-hover"
                              : "hover:bg-hover",
                        )}
                        data-hallucination-group={group.group}
                        {...point(group.group)}
                      >
                        <GroupCells group={group} open={isOpen} />
                      </Link>
                    ) : (
                      <div className={ROW} data-hallucination-group={group.group}>
                        <GroupCells group={group} open={false} />
                      </div>
                    )}
                  </Tooltip>
                </div>
                {isOpen ? <Kinds group={group} /> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

const ROW =
  "grid grid-cols-[1fr_3rem_3rem] items-center gap-3 rounded-md px-2 py-1.5 text-ui transition-colors duration-120";

function GroupCells({ group, open }: { group: GroupView; open: boolean }) {
  return (
    <>
      <span
        className={cn(
          "flex min-w-0 items-center gap-2",
          group.occurrences > 0 ? "text-fg" : "text-fg-subtle",
          group.active && "font-medium",
        )}
      >
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-[2px]", GROUP_COLOR[group.group])}
        />
        <span className="truncate">{group.label}</span>
        {group.kinds.length > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-normal text-fg-subtle">
            {plural(group.kinds.length, "kind")}
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3 transition-transform duration-200 motion-reduce:transition-none",
                open && "@max-5xl:rotate-90",
              )}
            />
          </span>
        ) : null}
      </span>
      {group.unchecked ? (
        <Tooltip content={group.unchecked}>
          <span
            className="col-span-2 text-right text-xs text-fg-subtle"
            data-hallucination-group-unchecked=""
          >
            Not checked
          </span>
        </Tooltip>
      ) : (
        <>
          <span className="text-right text-fg tabular-nums">{formatCount(group.occurrences)}</span>
          <span className="text-right text-fg-muted tabular-nums">{percent(group.share)}</span>
        </>
      )}
    </>
  );
}

/**
 * An open group's kinds, branching off its row: one arrow to each kind, with
 * its occurrences and its share of every hallucination. A kind narrows the
 * table to itself; the active one widens back to its group. Where the
 * section is too narrow for both side by side, the branch sits under the row.
 */
function Kinds({ group }: { group: GroupView }) {
  const several = group.kinds.length > 1;
  return (
    <div
      className="flex min-w-0 items-center transition-[opacity,translate] duration-200 ease-out @max-5xl:max-w-md @max-5xl:pl-4 motion-reduce:transition-none starting:-translate-x-2 starting:opacity-0"
      data-hallucination-kinds={group.group}
    >
      {/* From the row to the branch. */}
      <span aria-hidden className="h-px w-4 shrink-0 bg-line-strong @max-5xl:hidden" />
      <ul aria-label={`Kinds of ${group.label}`} className="flex min-w-0 flex-col @max-5xl:flex-1">
        {group.kinds.map((kind, index) => (
          <li key={kind.kind} className="relative flex min-w-0 items-center py-0.5">
            {/* The branch's spine, from the first kind's arrow to the last one's. */}
            {several ? (
              <span
                aria-hidden
                className={cn(
                  "absolute left-0 w-px bg-line-strong",
                  index === 0
                    ? "top-1/2 bottom-0"
                    : index === group.kinds.length - 1
                      ? "top-0 bottom-1/2"
                      : "inset-y-0",
                )}
              />
            ) : null}
            <span aria-hidden className="h-px w-4 shrink-0 bg-line-strong" />
            <ChevronRight aria-hidden className="-ml-2 size-3 shrink-0 text-fg-subtle" />
            <KindChoice kind={kind} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function KindChoice({ kind }: { kind: KindView }) {
  return (
    <Tooltip content={kind.meaning}>
      <Link
        href={kind.href}
        scroll={false}
        aria-current={kind.active ? "true" : undefined}
        className={cn(
          "ml-1 grid min-w-0 grid-cols-[minmax(0,1fr)_3rem_3rem] items-center gap-3 rounded-md px-2 py-1 text-ui transition-colors duration-120 @max-5xl:flex-1 @5xl:w-[22rem]",
          FOCUS,
          kind.active ? "bg-selected font-medium" : "hover:bg-hover",
        )}
        data-hallucination-kind-choice={kind.kind}
      >
        <span className="text-fg">{kind.label}</span>
        <span className="text-right text-fg tabular-nums">{formatCount(kind.occurrences)}</span>
        <span className="text-right text-fg-muted tabular-nums">{percent(kind.share)}</span>
      </Link>
    </Tooltip>
  );
}
