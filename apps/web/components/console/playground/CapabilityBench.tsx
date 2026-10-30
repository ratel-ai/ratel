"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Input } from "@ratel/design-system/input";
import { ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type BenchEntry,
  type BenchFilter,
  filterCounts,
  groupEntries,
  saveAffordance,
  visibleEntries,
} from "@/lib/synthesis/playground/bench-view";
import { MAX_BENCH_CAPABILITIES } from "@/lib/synthesis/playground/contract";
import type { EditedCapability } from "@/lib/synthesis/playground/export";
import type { CapabilityKind } from "@/lib/synthesis/playground/types";
import { BenchRow } from "./BenchRow";
import { EditsBar } from "./EditsBar";
import { KindIcon } from "./icons";

/** The catalog as a searchable, banded index. */

const FILTER_LABEL: Record<BenchFilter, string> = {
  all: "All",
  ranked: "In results",
  edited: "Edited",
  undescribed: "No description",
};

const FILTER_ORDER: BenchFilter[] = ["all", "ranked", "edited", "undescribed"];

/** Rows mounted before "Show more". */
const INITIAL_ROWS = 60;
const ROW_STEP = 100;

export function CapabilityBench({
  skills,
  tools,
  savedDescriptions,
  tagsById,
  savingId,
  truncated,
  focus,
  collapsed,
  onCollapsedChange,
  edits,
  projectSlug,
  onDiscardAll,
  onCommit,
  onRevert,
  onSaveSkill,
  onSaveSearchableDescription,
  canSaveSearchableDescription,
}: {
  skills: BenchEntry[];
  tools: BenchEntry[];
  /** Stored descriptions by id, for the "was" line on an edited row. */
  savedDescriptions: ReadonlyMap<string, string>;
  /** Effective tags by skill id. */
  tagsById: ReadonlyMap<string, string[]>;
  savingId: string | null;
  /** Per-kind: the catalog is larger than the bench read. */
  truncated: { skills: boolean; tools: boolean };
  /** A request from the results to open one capability's editor here. */
  focus: { id: string; kind: CapabilityKind; nonce: number } | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Every unsaved change, for the export and discard controls. */
  edits: readonly EditedCapability[];
  projectSlug: string;
  onDiscardAll: () => void;
  /** Commit one row's editor buffer. `tags` is null for tools. */
  onCommit: (kind: CapabilityKind, id: string, description: string, tags: string[] | null) => void;
  onRevert: (kind: CapabilityKind, id: string) => void;
  onSaveSkill: (id: string, description: string | null) => void;
  /**
   * Persist a managed tool's searchable description as a Cloud override, or
   * clear it with null so the runtime's own text applies again.
   */
  onSaveSearchableDescription: (id: string, description: string | null) => void;
  /** Whether the runtime-catalog write surface is open for this project. */
  canSaveSearchableDescription: boolean;
}) {
  const [tab, setTab] = useState<CapabilityKind>("tool");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<BenchFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [limit, setLimit] = useState(INITIAL_ROWS);

  const entries = tab === "skill" ? skills : tools;
  const counts = useMemo(() => filterCounts(entries), [entries]);
  const matched = useMemo(
    () => visibleEntries(entries, { search, filter }),
    [entries, search, filter],
  );
  const visible = matched.slice(0, limit);
  const groups = useMemo(() => groupEntries(visible), [visible]);
  const scope = `${tab}\u0000${search}\u0000${filter}`;
  const [lastScope, setLastScope] = useState(scope);

  /** Answer a pencil clicked on a result row. */
  const focusNonce = focus?.nonce ?? 0;
  const [lastFocusNonce, setLastFocusNonce] = useState(focusNonce);
  const focusing = focus !== null && focusNonce !== lastFocusNonce;
  if (focus && focusing) {
    setLastFocusNonce(focusNonce);
    if (collapsed) onCollapsedChange(false);
    setTab(focus.kind);
    setSearch(focus.id);
    setFilter("all");
    setLimit(INITIAL_ROWS);
    setOpenId(focus.id);
    setEditingId(focus.id);
    setLastScope(`${focus.kind}\u0000${focus.id}\u0000all`);
  }

  if (!focusing && scope !== lastScope) {
    setLastScope(scope);
    setLimit(INITIAL_ROWS);
    setOpenId(null);
    setEditingId(null);
  }
  const editedTotal = filterCounts(skills).edited + filterCounts(tools).edited;
  const capped = tab === "skill" ? truncated.skills : truncated.tools;

  /** How the list should arrive when it is replaced. */
  const swapKey = `${tab}\u0000${filter}`;
  const [swap, setSwap] = useState({ key: swapKey, animation: "" });
  if (swapKey !== swap.key) {
    const cameFromTab = swap.key.split("\u0000")[0];
    setSwap({
      key: swapKey,
      animation:
        cameFromTab === tab
          ? "bench-settle"
          : tab === "skill"
            ? "bench-swap-right"
            : "bench-swap-left",
    });
  }

  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus === null) return;
    sectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [focus]);

  return (
    <section
      ref={sectionRef}
      aria-labelledby="playground-bench-title"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-2xl border transition-colors",
        collapsed
          ? "border-indigo-300/25 bg-indigo-300/[0.05]"
          : "border-forest-300 bg-forest-600/35",
      )}
    >
      <button
        type="button"
        onClick={() => onCollapsedChange(!collapsed)}
        aria-expanded={!collapsed}
        aria-controls="playground-bench-body"
        className={cn(
          "group/toggle flex w-full shrink-0 items-center gap-3 px-4 py-3 text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-indigo-300/60",
          collapsed ? "hover:bg-indigo-300/[0.06]" : "bg-base-deep/30 hover:bg-base-deep/50",
        )}
      >
        <span
          className={cn(
            "inline-flex size-9 shrink-0 items-center justify-center gap-0.5 rounded-lg transition-colors",
            collapsed
              ? "bg-indigo-300/15 text-indigo-300 group-hover/toggle:bg-indigo-300/25"
              : "bg-forest/40 text-warm-muted group-hover/toggle:text-cream",
          )}
          aria-hidden
        >
          <KindIcon kind="tool" className="size-3.5" />
          <KindIcon kind="skill" className="size-3.5" />
        </span>

        <span className="min-w-0 flex-1">
          <h2 id="playground-bench-title" className="truncate text-sm font-medium text-cream">
            Skills &amp; tools
          </h2>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-warm-muted">
            <span className="inline-flex items-center gap-1 font-mono tabular-nums">
              <KindIcon kind="tool" className="size-3" />
              {tools.length}
            </span>
            <span className="inline-flex items-center gap-1 font-mono tabular-nums">
              <KindIcon kind="skill" className="size-3" />
              {skills.length}
            </span>
            {editedTotal > 0 && (
              <span className="font-mono tabular-nums text-coral">{editedTotal} edited</span>
            )}
            {collapsed && (
              <span className="truncate">search, rewrite a description, test again</span>
            )}
          </span>
        </span>

        <span
          className={cn(
            "shrink-0 font-mono text-[10px] uppercase tracking-[0.09em]",
            collapsed ? "text-indigo-300" : "text-warm-muted",
          )}
        >
          {collapsed ? "Open" : "Hide"}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 transition-transform duration-300 ease-out motion-reduce:transition-none",
            collapsed ? "-rotate-90 text-indigo-300" : "text-warm-muted",
          )}
          aria-hidden
        />
      </button>

      <div
        id="playground-bench-body"
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className="flex max-h-[30rem] min-h-0 flex-col border-t border-forest-300"
            // Nothing inside a folded panel should be reachable by keyboard.
            inert={collapsed}
          >
            <EditsBar edits={edits} projectSlug={projectSlug} onDiscardAll={onDiscardAll} />

            <div
              role="tablist"
              aria-label="Capability kind"
              className="flex shrink-0 items-end gap-1 border-b border-forest-300 px-2 pt-1.5"
            >
              <BenchTab
                kind="tool"
                active={tab === "tool"}
                onClick={() => setTab("tool")}
                label="Tools"
                count={tools.length}
                edited={filterCounts(tools).edited}
              />
              <BenchTab
                kind="skill"
                active={tab === "skill"}
                onClick={() => setTab("skill")}
                label="Skills"
                count={skills.length}
                edited={filterCounts(skills).edited}
              />
            </div>

            <div className="shrink-0 border-b border-forest-300/60 px-3 py-2">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-warm-muted"
                  aria-hidden
                />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label={`Search ${tab === "skill" ? "skills" : "tools"}`}
                  placeholder={`Search ${entries.length} ${tab === "skill" ? "skills" : "tools"}…`}
                  className="h-7 rounded-lg border-forest-300 bg-base-deep/40 pr-2 pl-8 text-xs text-cream placeholder:text-warm-muted/60 hover:border-forest-300 focus-visible:border-coral focus-visible:ring-0"
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="mr-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-warm-muted">
                  Show
                </span>
                {FILTER_ORDER.map((candidate) => (
                  <FilterChip
                    key={candidate}
                    active={filter === candidate}
                    // A filter that would show nothing is not worth a click.
                    disabled={counts[candidate] === 0 && candidate !== "all"}
                    onClick={() => setFilter(candidate)}
                    label={FILTER_LABEL[candidate]}
                    count={counts[candidate]}
                  />
                ))}
              </div>
            </div>

            <div id="playground-bench-list" className="min-h-0 flex-1 overflow-y-auto">
              <div key={swap.key} className={swap.animation}>
                {groups.map((group) => (
                  <div key={group.key}>
                    {group.label !== "" && (
                      <h3 className="sticky top-0 z-10 flex items-baseline gap-1.5 border-y border-forest-300/40 bg-forest-600/95 px-3 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-warm-muted backdrop-blur first:border-t-0">
                        {group.label}
                        <span className="tabular-nums opacity-60">{group.entries.length}</span>
                      </h3>
                    )}
                    <div className="divide-y divide-forest-300/30">
                      {group.entries.map((entry) => {
                        const affordance = saveAffordance(entry, {
                          canSaveSearchableDescription,
                        });
                        return (
                          <BenchRow
                            key={entry.id}
                            entry={entry}
                            open={openId === entry.id}
                            editing={editingId === entry.id}
                            onToggle={() => {
                              const next = openId === entry.id ? null : entry.id;
                              setOpenId(next);
                              if (next !== entry.id) setEditingId(null);
                            }}
                            onEdit={() => {
                              setOpenId(entry.id);
                              setEditingId(entry.id);
                            }}
                            onCancelEdit={() => setEditingId(null)}
                            saved={savedDescriptions.get(entry.id) ?? ""}
                            tags={entry.kind === "skill" ? (tagsById.get(entry.id) ?? []) : null}
                            onCommit={(description, tags) => {
                              onCommit(entry.kind, entry.id, description, tags);
                              setEditingId(null);
                            }}
                            onRevert={() => {
                              onRevert(entry.kind, entry.id);
                              setEditingId(null);
                            }}
                            saveAffordance={affordance}
                            onSaveToCatalog={
                              affordance.kind === "blocked"
                                ? null
                                : (description) => {
                                    if (affordance.kind === "skill") {
                                      onSaveSkill(entry.id, description);
                                    } else {
                                      onSaveSearchableDescription(entry.id, description);
                                    }
                                    setEditingId(null);
                                  }
                            }
                            saving={savingId === entry.id}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
                {matched.length > visible.length && (
                  <div className="px-3 py-2 text-center">
                    <Button
                      size="xs"
                      variant="secondary"
                      className="border-forest-300 bg-forest-600/70 hover:border-forest-300/80 hover:bg-forest-600"
                      onClick={() => setLimit((current) => current + ROW_STEP)}
                    >
                      Show {Math.min(ROW_STEP, matched.length - visible.length)} more
                    </Button>
                  </div>
                )}
                {visible.length === 0 && (
                  <p className="px-3 py-8 text-center text-xs text-warm-muted">
                    {entries.length === 0
                      ? tab === "skill"
                        ? "No skills yet. Create one from Catalogs → Skills."
                        : "No tools observed yet. They appear here once telemetry reports them."
                      : "Nothing matches that filter."}
                  </p>
                )}
              </div>
            </div>

            {(visible.length !== entries.length || capped) && (
              <p className="shrink-0 border-t border-forest-300/60 px-3 py-1.5 font-mono text-[10px] text-warm-muted">
                Showing {visible.length} of {matched.length}
                {matched.length !== entries.length && ` matched · ${entries.length} loaded`}
                {capped && ` · first ${MAX_BENCH_CAPABILITIES} only`}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** One narrowing lens over the list. */
function FilterChip({
  active,
  disabled,
  onClick,
  label,
  count,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <Button
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "h-auto gap-1.5 rounded-lg px-2 py-1 text-[11px] font-normal",
        "transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100",
        "focus-visible:ring-1 focus-visible:ring-indigo-300/60 focus-visible:ring-offset-0",
        active
          ? "border-indigo-300/40 bg-indigo-300/15 font-medium text-cream"
          : "border-forest-300 bg-base-deep/30 text-cream-dim hover:border-forest-300 hover:bg-forest/50 hover:text-cream",
        disabled && "disabled:opacity-35",
      )}
    >
      {label}
      <span
        className={cn(
          "font-mono text-[10px] tabular-nums",
          active ? "text-indigo-300" : "text-warm-muted",
        )}
      >
        {count}
      </span>
    </Button>
  );
}

function BenchTab({
  kind,
  active,
  onClick,
  label,
  count,
  edited,
}: {
  kind: CapabilityKind;
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  edited: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative -mb-px inline-flex items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-1.5 text-xs",
        "transition-[background-color,color,transform] duration-150 active:translate-y-px motion-reduce:transition-none motion-reduce:active:translate-y-0",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-indigo-300/60",
        active
          ? "border-forest-300 bg-forest-600 font-medium text-cream"
          : "border-transparent bg-base-deep/50 text-warm-muted hover:bg-base-deep/70 hover:text-cream-dim",
      )}
    >
      {active && (
        <span className="absolute inset-x-0 top-0 h-0.5 rounded-t bg-indigo-300" aria-hidden />
      )}
      <KindIcon
        kind={kind}
        className={cn("size-3.5", active ? "text-indigo-300" : "text-warm-muted")}
      />
      {label}
      <span
        className={cn(
          "font-mono text-[10px] tabular-nums",
          active ? "text-cream-dim" : "text-warm-muted/70",
        )}
      >
        {count}
      </span>
      {edited > 0 && (
        <span
          role="img"
          className="size-1.5 rounded-full bg-coral"
          aria-label={`${edited} edited`}
        />
      )}
    </button>
  );
}
