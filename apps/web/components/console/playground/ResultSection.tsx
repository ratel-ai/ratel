"use client";

import { Autocomplete, type AutocompleteItem } from "@ratel/design-system/autocomplete";
import { Badge } from "@ratel/design-system/badge";
import { IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { NounIcon, ToolPin } from "@ratel/design-system/entity";
import { Section } from "@ratel/design-system/section";
import { SegmentedControl } from "@ratel/design-system/tabs";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
} from "lucide-react";
import { CompareView } from "@/components/console/playground/CompareView";
import { Highlighted } from "@/components/console/playground/Highlighted";
import type { ComparisonColumn } from "@/lib/synthesis/playground/calibration-compare";
import {
  type Movement,
  movementWords,
  type ResultList,
  type Tone,
  type Verdict,
} from "@/lib/synthesis/playground/result-view";
import type { CapabilityKind } from "@/lib/synthesis/playground/types";

export type ResultView = "list" | "compare";

const VIEW_OPTIONS = [
  { value: "list", label: "List" },
  { value: "compare", label: "Compare" },
] as const satisfies readonly { value: ResultView; label: string }[];

const NOUN: Record<CapabilityKind, { one: string; many: string; title: string }> = {
  tool: { one: "tool", many: "tools", title: "Tools" },
  skill: { one: "skill", many: "skills", title: "Skills" },
};

/**
 * One kind's results: the answer in a sentence, then the ranked list, or the
 * same search side by side (Compare) when there is a before to hold it against.
 *
 * Each row is a name and one line of the description it matched on, with the
 * ask's words lit: the reason for its place, without a sentence saying so. The
 * rest (how close the race was, the scores) waits in the Panel a click away.
 */
export function ResultSection({
  list,
  catalogSize,
  terms,
  verdict,
  changes,
  emptyReason,
  expected,
  onExpect,
  catalogItems,
  onOpen,
  openId,
  compare,
  view,
  onViewChange,
}: {
  list: ResultList;
  catalogSize: number;
  /** The ask's words, to light in names and descriptions. */
  terms: ReadonlySet<string>;
  verdict: Verdict | null;
  /** What the reader's changes did here, one line each. */
  changes: readonly Verdict[];
  emptyReason: string | null;
  /** The capability the reader expects first, when they named one of this kind. */
  expected: string | null;
  onExpect: (id: string | null) => void;
  /** Every capability of this kind, for the "which should come first" picker. */
  catalogItems: readonly AutocompleteItem[];
  onOpen: (id: string) => void;
  openId: string | null;
  /** The same search side by side (variants, before, after); null when there is only one list. */
  compare: readonly ComparisonColumn[] | null;
  view: ResultView;
  onViewChange: (view: ResultView) => void;
}) {
  const noun = NOUN[list.kind];
  const shown = list.rows.length;
  const comparing = view === "compare" && compare !== null;

  const picker = expected ? (
    <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
      Should come first
      <button
        type="button"
        onClick={() => onOpen(expected)}
        className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ToolPin
          name={expected}
          kind={list.kind}
          className="hover:border-line-strong hover:text-fg"
        />
      </button>
      <IconButton
        size="icon-sm"
        label="Stop expecting this one"
        icon={<X strokeWidth={1.5} />}
        onClick={() => onExpect(null)}
      />
    </span>
  ) : catalogSize > 1 ? (
    <Autocomplete
      items={catalogItems}
      onPick={(item) => onExpect(item.id)}
      label={`Which ${noun.one} should come first?`}
      placeholder="Which should be first?"
      empty={`No ${noun.one} by that name`}
      className="max-w-56 sm:w-56"
    />
  ) : null;

  return (
    <Section
      title={
        <span className="inline-flex items-center gap-1.5">
          <NounIcon noun={list.kind} />
          {noun.title}
        </span>
      }
      description={shown > 0 ? `Top ${shown} of ${catalogSize}` : `${catalogSize} in your catalog`}
      actions={
        <>
          {compare ? (
            <SegmentedControl
              label="Show as"
              options={VIEW_OPTIONS}
              value={view}
              onValueChange={onViewChange}
            />
          ) : null}
          {picker}
        </>
      }
    >
      {verdict || changes.length > 0 ? (
        <div className="flex flex-col gap-1" aria-live="polite">
          {verdict ? <VerdictLine verdict={verdict} /> : null}
          {changes.map((change) => (
            <VerdictLine key={change.text} verdict={change} />
          ))}
        </div>
      ) : null}

      {comparing ? (
        <CompareView
          columns={compare}
          terms={terms}
          expected={expected}
          openId={openId}
          onOpen={onOpen}
        />
      ) : shown === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-ui text-fg-muted">
          {emptyReason}
        </p>
      ) : (
        <ol
          aria-label={`${noun.title}, best match first`}
          className="overflow-hidden rounded-lg border border-line bg-raised"
        >
          {list.rows.map((row) => (
            <li key={row.hit.id} className="border-b border-line last:border-b-0">
              <button
                type="button"
                onClick={() => onOpen(row.hit.id)}
                aria-current={openId === row.hit.id ? "true" : undefined}
                className={cn(
                  "group grid w-full grid-cols-[1.75rem_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2.5 text-left outline-none transition-colors duration-120",
                  "hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
                  openId === row.hit.id && "bg-selected hover:bg-selected",
                )}
              >
                <span
                  className={cn(
                    "pt-px text-right text-ui tabular-nums",
                    row.rank === 1 ? "font-semibold text-fg" : "text-fg-subtle",
                  )}
                >
                  {row.rank}
                </span>
                <span className="min-w-0">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 truncate font-mono text-ui text-fg">
                      <Highlighted text={row.hit.id} terms={terms} />
                    </span>
                    {row.hit.id === expected ? (
                      <Badge tone={row.rank === 1 ? "success" : "warning"}>Expected</Badge>
                    ) : null}
                    {row.hit.edited ? <Badge tone="info">Changed</Badge> : null}
                  </span>
                  <span className="mt-0.5 line-clamp-1 text-ui text-fg-muted">
                    {row.hit.searchableDescription.trim() !== "" ? (
                      <Highlighted text={row.hit.searchableDescription} terms={terms} />
                    ) : (
                      <span className="text-fg-subtle">No description</span>
                    )}
                  </span>
                </span>
                <span className="flex items-center gap-3 pt-px">
                  {row.movement ? (
                    <MovementMark movement={row.movement} judged={row.hit.edited} />
                  ) : null}
                  <ChevronRight
                    aria-hidden
                    strokeWidth={1.5}
                    className="size-4 text-fg-faint transition-colors group-hover:text-fg-muted"
                  />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {!comparing && list.pushedOut.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
          Pushed out by your changes:
          {list.pushedOut.map((hit) => (
            <button
              key={hit.id}
              type="button"
              onClick={() => onOpen(hit.id)}
              className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ToolPin
                name={hit.id}
                kind={list.kind}
                className="hover:border-line-strong hover:text-fg"
              />
            </button>
          ))}
        </p>
      ) : null}
    </Section>
  );
}

const TONE_ICON: Record<Tone, { icon: typeof Info; className: string }> = {
  success: { icon: CircleCheck, className: "text-success" },
  warning: { icon: TriangleAlert, className: "text-warning" },
  neutral: { icon: Info, className: "text-fg-subtle" },
};

function VerdictLine({ verdict }: { verdict: Verdict }) {
  const { icon: Icon, className } = TONE_ICON[verdict.tone];
  return (
    <p className="flex items-start gap-2 text-sm text-fg">
      <Icon aria-hidden strokeWidth={1.5} className={cn("mt-0.5 size-4 shrink-0", className)} />
      <span>{verdict.text}</span>
    </p>
  );
}

/** How far a row moved since the saved catalog: an arrow and a number, or a word. `judged` rows are the reader's own changes. */
function MovementMark({ movement, judged }: { movement: Movement; judged: boolean }) {
  const words = movementWords(movement);
  if (movement.kind === "same") {
    return <span className="sr-only">{words}</span>;
  }
  if (movement.kind === "new") {
    return <Badge tone={judged ? "success" : "neutral"}>New</Badge>;
  }
  const Icon = movement.kind === "up" ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium tabular-nums",
        // Colored only for what the reader changed, where up is the point;
        // a neighbour moving is a direction, not good or bad news.
        !judged ? "text-fg-muted" : movement.kind === "up" ? "text-success" : "text-warning",
      )}
    >
      <Icon aria-hidden strokeWidth={2} className="size-3" />
      {movement.places}
      <span className="sr-only">{words}</span>
    </span>
  );
}
