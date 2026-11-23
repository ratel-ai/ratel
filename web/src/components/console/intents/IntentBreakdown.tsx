"use client";

import { cn } from "@ratel/design-system/cn";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { NounIcon } from "@ratel/design-system/entity";
import { Skeleton } from "@ratel/design-system/states";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { AskIcon } from "@/components/console/intents/marks";
import { Block, IntentButton, n, pct, Share } from "@/components/console/intents/panel-parts";
import type { AskForGroup, IntentBreakdown, WayOfAsking } from "@/lib/views/intents/breakdown";

/** Things they ask for listed before "Show more": the busiest carry most asks, the rest are a long tail. */
export const GROUPS_AT_FIRST = 6;
/** Ways of asking a group shows before "Show more". */
export const WAYS_AT_FIRST = 4;
/** Other intents named beside a group that spans them. */
const ALSO_UNDER_SHOWN = 3;

type Names = ReadonlyMap<string, string>;
type Open = (topicId: string) => void;

/**
 * An intent's asks, one level down (DESIGN.md, "The product's nouns"): "What
 * they ask for" (one action on one thing each, most asked first), each
 * opening onto its "Ways people ask it" (the phrasings, quoted, with true
 * counts and a few more asks like them). A thing no model has named yet
 * reads as its busiest ask, quoted. A level with one child is skipped: an
 * intent that is one thing goes straight to its ways, and one way alone says
 * nothing the intent's name doesn't. The busiest come first and the long tail
 * waits behind "Show more". Every count is of this intent's asks; other
 * intents are pins that open their own panel. Asks and names are text only,
 * never an attribute.
 */
export function AskFor({
  breakdown,
  names,
  onOpen,
}: {
  breakdown: IntentBreakdown;
  names: Names;
  onOpen: Open;
}) {
  const { groups, more, skipped } = breakdown.whatTheyAskFor;
  const only = skipped ? groups[0] : undefined;
  if (only) {
    const count = only.waysOfAsking.ways.length + only.waysOfAsking.more;
    if (count <= 1) return null;
    return (
      <Block mark={<AskIcon />} title="Ways people ask it" count={count}>
        <div className="flex flex-col gap-2" data-intent-breakdown="ways">
          <Ways group={only} />
          <AlsoUnder group={only} names={names} onOpen={onOpen} />
          <Footnote breakdown={breakdown} names={names} onOpen={onOpen} />
        </div>
      </Block>
    );
  }
  if (groups.length === 0) return null;
  return (
    <Block noun="intent" title="What they ask for" count={groups.length + more}>
      <div className="flex flex-col gap-2" data-intent-breakdown="groups">
        <Groups groups={groups} more={more} names={names} onOpen={onOpen} />
        <Footnote breakdown={breakdown} names={names} onOpen={onOpen} />
      </div>
    </Block>
  );
}

/** The things they ask for, busiest first: the first few, then the rest on request. */
function Groups({
  groups,
  more,
  names,
  onOpen,
}: {
  groups: readonly AskForGroup[];
  more: number;
  names: Names;
  onOpen: Open;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? groups : groups.slice(0, GROUPS_AT_FIRST);
  const hidden = groups.length - shown.length;
  // The busiest one that opens onto ways starts open: it shows what a row holds.
  const opened = groups.find((group) => !group.waysOfAsking.skipped)?.id;
  return (
    <>
      <ul className="flex flex-col">
        {shown.map((group) => (
          <GroupRow
            key={group.id}
            group={group}
            defaultOpen={group.id === opened}
            names={names}
            onOpen={onOpen}
          />
        ))}
      </ul>
      <MoreOrRest
        hidden={hidden}
        rest={more}
        restLabel="more, asked less often"
        onShow={() => setAll(true)}
      />
    </>
  );
}

/** "Show N more" while some are folded; then how many were never listed. */
function MoreOrRest({
  hidden,
  rest,
  restLabel,
  onShow,
}: {
  hidden: number;
  rest: number;
  restLabel: string;
  onShow: () => void;
}) {
  if (hidden > 0) {
    return (
      <button
        type="button"
        onClick={onShow}
        className="self-start rounded-md px-1 text-xs text-fg-muted outline-none transition-colors duration-120 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
      >
        Show {n(hidden)} more
      </button>
    );
  }
  return rest > 0 ? (
    <p className="text-xs text-fg-subtle tabular-nums">
      and {n(rest)} {restLabel}
    </p>
  ) : null;
}

const ROW_GRID =
  "grid w-full grid-cols-[1rem_minmax(0,1fr)_auto_auto_2.5rem] items-center gap-x-2 rounded-md py-1.5 pr-1 text-left";

/** A thing's asks, its share as cells (its percent says the same to a screen reader) and the percent. */
function GroupNumbers({ group }: { group: AskForGroup }) {
  return (
    <>
      <span className="text-xs text-fg-muted tabular-nums">
        {n(group.asks)} {group.asks === 1 ? "ask" : "asks"}
      </span>
      <span aria-hidden className="flex">
        <DotMeter
          value={group.share}
          cells={10}
          tone="neutral"
          label={`${pct(group.share)} of its asks`}
        />
      </span>
      <span className="text-right text-xs text-fg-muted tabular-nums">{pct(group.share)}</span>
    </>
  );
}

/**
 * One thing they ask for: its name, asks and share; it opens onto its ways.
 * Asked one way only, it has nothing to open (a level with one child is
 * skipped): a named one shows that way under its name, a quoted one already
 * is it.
 */
function GroupRow({
  group,
  defaultOpen,
  names,
  onOpen,
}: {
  group: AskForGroup;
  defaultOpen: boolean;
  names: Names;
  onOpen: Open;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const label = group.quoted ? `“${group.label}”` : group.label;
  if (group.waysOfAsking.skipped) {
    const [only] = group.waysOfAsking.ways;
    return (
      <li className="flex flex-col">
        <div className={ROW_GRID}>
          <span aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-ui text-fg">{label}</span>
            {only && !group.quoted ? (
              <span className="truncate text-xs text-fg-subtle">“{only.label}”</span>
            ) : null}
          </span>
          <GroupNumbers group={group} />
        </div>
        <div className="pl-6">
          <AlsoUnder group={group} names={names} onOpen={onOpen} />
        </div>
      </li>
    );
  }
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          ROW_GRID,
          "group outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus",
        )}
      >
        <ChevronRight
          aria-hidden
          strokeWidth={1.5}
          className={cn(
            "size-3.5 text-fg-subtle transition-transform duration-160 ease-enter motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate text-ui text-fg">{label}</span>
        <GroupNumbers group={group} />
      </button>
      {open ? (
        <div id={id} className="flex flex-col gap-2 pt-1 pb-3 pl-6">
          <Ways group={group} />
          <AlsoUnder group={group} names={names} onOpen={onOpen} />
        </div>
      ) : null}
    </li>
  );
}

/** A group's ways of asking, most asked first: the first few, then the rest on request. */
function Ways({ group }: { group: AskForGroup }) {
  const [all, setAll] = useState(false);
  const { ways, more } = group.waysOfAsking;
  const shown = all ? ways : ways.slice(0, WAYS_AT_FIRST);
  const hidden = ways.length - shown.length;
  return (
    <div className="flex flex-col gap-1.5">
      <ul className="flex flex-col gap-1.5">
        {shown.map((way) => (
          <WayRow key={way.id} way={way} />
        ))}
      </ul>
      <MoreOrRest
        hidden={hidden}
        rest={more}
        restLabel="more ways, asked less often"
        onShow={() => setAll(true)}
      />
    </div>
  );
}

/** One way of asking: its most typical ask as written, how many of the group's asks came this way, and a few more like it. */
function WayRow({ way }: { way: WayOfAsking }) {
  const share = way.of === 0 ? 0 : way.asks / way.of;
  return (
    <li className="flex flex-col gap-1 rounded-md bg-raised py-2 pr-2 pl-3">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-3">
        <p className="min-w-0 text-ui break-words text-fg">“{way.label}”</p>
        <span className="pt-0.5 text-xs whitespace-nowrap text-fg-muted tabular-nums">
          {n(way.asks)} of {n(way.of)}
        </span>
        <span aria-hidden className="flex pt-1">
          <DotMeter value={share} cells={5} tone="neutral" label={`${pct(share)} of these asks`} />
        </span>
      </div>
      {way.samples.length > 0 ? (
        <p className="line-clamp-1 text-xs break-words text-fg-subtle">
          <span className="sr-only">Also asked as: </span>
          {way.samples.map((sample) => `“${sample}”`).join(" · ")}
        </p>
      ) : null}
    </li>
  );
}

/** A group that spans intents: the others it is asked under, with their asks. */
function AlsoUnder({ group, names, onOpen }: { group: AskForGroup; names: Names; onOpen: Open }) {
  const others = group.alsoIn
    .filter((other) => names.has(other.topicId))
    .slice(0, ALSO_UNDER_SHOWN);
  if (others.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-fg-subtle">
      <span>Also asked under</span>
      {others.map((other) => (
        <span key={other.topicId} className="inline-flex min-w-0 items-center gap-1.5">
          <IntentButton name={names.get(other.topicId)!} onOpen={() => onOpen(other.topicId)} />
          <span className="tabular-nums">{n(other.asks)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Under the list, numbers only: how many asks it was read from (the newest,
 * when the window held more), and the asks that read more like another intent.
 */
function Footnote({
  breakdown,
  names,
  onOpen,
}: {
  breakdown: IntentBreakdown;
  names: Names;
  onOpen: Open;
}) {
  const ungrouped = breakdown.asks - breakdown.placed;
  // Counted over the groups it names a home for, so the number is the pins' own.
  const elsewhere = breakdown.elsewhere.groups.filter((group) => names.has(group.topicId));
  const homes = [...new Set(elsewhere.map((group) => group.topicId))];
  const elsewhereAsks = elsewhere.reduce((sum, group) => sum + group.asks, 0);
  const read = breakdown.capped
    ? `Read from the newest ${n(breakdown.asks)} asks${ungrouped > 0 ? `, ${n(breakdown.placed)} grouped` : ""}`
    : ungrouped > 0
      ? `Grouped from ${n(breakdown.placed)} of ${n(breakdown.asks)} asks`
      : null;
  if (!read && homes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-fg-subtle tabular-nums">
      {read ? <span>{read}</span> : null}
      {homes.length > 0 ? (
        <>
          {read ? <span aria-hidden>·</span> : null}
          <span>
            {n(elsewhereAsks)} {elsewhereAsks === 1 ? "ask reads" : "asks read"} more like
          </span>
          {homes.map((topicId) => (
            <IntentButton key={topicId} name={names.get(topicId)!} onOpen={() => onOpen(topicId)} />
          ))}
        </>
      ) : null}
    </div>
  );
}

/** Other intents wanted in the same ask, most first, each counted once per ask. */
export function AlsoWants({
  breakdown,
  names,
  onOpen,
}: {
  breakdown: IntentBreakdown;
  names: Names;
  onOpen: Open;
}) {
  const wanted = breakdown.alsoWants.filter((other) => names.has(other.topicId));
  if (wanted.length === 0) return null;
  return (
    <Block noun="intent" title="Also wanted in the same ask">
      <ul className="flex flex-col gap-1.5" data-intent-also-wants="">
        {wanted.map((other) => (
          <li
            key={other.topicId}
            className="grid grid-cols-[minmax(0,1fr)_auto_2.5rem] items-center gap-3"
          >
            <IntentButton name={names.get(other.topicId)!} onOpen={() => onOpen(other.topicId)} />
            <Share share={other.share} label="of its asks" />
          </li>
        ))}
      </ul>
    </Block>
  );
}

/** While the panel's detail is read: the block's place, held. */
export function AskForLoading() {
  return (
    <section aria-busy="true" className="flex flex-col gap-2">
      <h3 className="flex min-h-7 items-center gap-1.5 text-sm font-semibold text-fg">
        <NounIcon noun="intent" />
        What they ask for
      </h3>
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className={cn("h-5", index === 1 ? "w-2/3" : "w-4/5")} />
        ))}
      </div>
    </section>
  );
}
