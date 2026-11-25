import {
  type OfferedWidgets,
  type OverviewLayout,
  type OverviewLayoutChange,
  type OverviewPlacement,
  WIDGET_TITLES,
} from "./layout";
import {
  isUnreadable,
  type OverviewArrangement,
  readArrangement,
  type StoredOverviewLayout,
  storeArrangement,
} from "./stored";

/**
 * The changes of one person's layout, newest first. One change is one save that gives another
 * layout: a drag is saved when it ends, so it is one entry, and a save that changes nothing is
 * none. An undo and a restore are changes too. Pure.
 */

export const KEPT_CHANGES = 25;

/** Where a change came from. The author is the person whose layout it is: nobody else can change it. */
export type ChangeSource = { kind: "web" } | { kind: "mcp"; client: string | null };

export interface LayoutChangeEntry {
  /** Counts up from 1 for each person and project. */
  seq: number;
  kind: "change" | "undo" | "restore";
  source: ChangeSource;
  at: Date;
  /** What changed, in plain words. */
  summary: string;
  /** The entry an undo took back. */
  undoes: number | null;
  /** The stored value before it; null when there was none. */
  before: unknown;
  /** The stored value after it. */
  layout: unknown;
}

/** What is stored of one person's layout in one project. */
export interface LayoutRecord {
  /** Undefined without a row. */
  layout: unknown;
  /** Newest first, at most `KEPT_CHANGES`. */
  entries: readonly LayoutChangeEntry[];
}

/** A change that is ready to be stored, as the entry with `seq`. */
export type LayoutWrite = Omit<LayoutChangeEntry, "at" | "layout"> & {
  layout: StoredOverviewLayout;
};

export const NO_RECORD: LayoutRecord = { layout: undefined, entries: [] };

/**
 * Names this exact state. It has the stored value in it and not only the count, because a build
 * from before the history changes the layout without an entry.
 */
export function revisionOf({ layout, entries }: LayoutRecord): string {
  return `${entries[0]?.seq ?? 0}.${layout === undefined ? "0" : fingerprint(canonical(layout))}`;
}

/** `a` is a state from before `b`. */
export function isEarlier(a: string, b: string): boolean {
  return Number.parseInt(a, 10) < Number.parseInt(b, 10);
}

/** The next entry; null when the change gives the layout that is there already. An undo is always one, so the next undo goes further back. */
export function nextChange(
  record: LayoutRecord,
  next: OverviewArrangement,
  offered: OfferedWidgets,
  what: Pick<LayoutChangeEntry, "kind" | "source" | "summary"> & { undoes?: number | null },
): LayoutWrite | null {
  const layout = storeArrangement(next);
  if (
    what.kind !== "undo" &&
    !isUnreadable(record.layout) &&
    canonical(layout) === canonical(storeArrangement(readArrangement(record.layout, offered)))
  )
    return null;
  return {
    undoes: null,
    ...what,
    seq: (record.entries[0]?.seq ?? 0) + 1,
    before: record.layout ?? null,
    layout,
  };
}

export interface UndoTarget {
  /** Null for a change that a build without the history made. */
  seq: number | null;
  summary: string;
  /** The stored value to go back to; null for the default. */
  layout: unknown;
}

/** The latest change that is not taken back yet; an undo itself is never taken back. */
export function undoTarget({ layout, entries }: LayoutRecord): UndoTarget | null {
  const [latest] = entries;
  if (latest && canonical(latest.layout) !== canonical(layout))
    return { seq: null, summary: UNRECORDED, layout: latest.layout };
  const undone = new Set(entries.map(({ undoes }) => undoes));
  const target = entries.find(({ kind, seq }) => kind !== "undo" && !undone.has(seq));
  return target ? { seq: target.seq, summary: target.summary, layout: target.before } : null;
}

/** What a change did, in plain words. */
export function describeChange(
  change: OverviewLayoutChange,
  before: OverviewLayout,
  after: OverviewLayout,
): string {
  if (change.kind === "reset") return "Reset to the default layout";
  if (change.kind === "add") return `Added ${titleOf(change.widget)}`;
  if (change.kind === "remove") return `Removed ${titleOf(change.widget)}`;
  if (change.kind === "resize") return `Resized ${titleOf(change.widget)}`;
  if (change.kind === "move") return `Moved ${titleOf(change.widget)}`;
  const changed = changedWidgets(before, after);
  // Others made room for the one the person took.
  const taken = changed.filter(({ widget }) => widget.id === change.widget);
  const named = taken.length > 0 ? taken : changed;
  const verb = named.some(({ resized }) => resized) ? "Resized" : "Moved";
  return named.length === 0
    ? "Arranged the widgets"
    : `${verb} ${listed(named.map(({ widget }) => titleOf(widget.id)))}`;
}

export const describeUndo = ({ summary }: Pick<UndoTarget, "summary">) =>
  clipped(`Took back: ${summary}`);

/** A restore of a restore is of the same layout, and says the same. */
export const describeRestore = ({ kind, summary }: Pick<LayoutChangeEntry, "kind" | "summary">) =>
  kind === "restore" ? summary : clipped(`Restored the layout after: ${summary}`);

// — Helpers ——————————————————————————————————————————————————————————————————

const UNRECORDED = "A change that has no entry";
const MAX_SUMMARY = 200;

function changedWidgets(before: OverviewLayout, after: OverviewLayout) {
  const was = new Map(before.map((widget) => [widget.id, widget]));
  return after
    .filter(({ removed }) => !removed)
    .flatMap((widget) => {
      const old: OverviewPlacement | undefined = was.get(widget.id);
      if (!old) return [];
      const resized = old.w !== widget.w || old.h !== widget.h;
      return resized || old.x !== widget.x || old.y !== widget.y ? [{ widget, resized }] : [];
    });
}

function titleOf(id: OverviewPlacement["id"]): string {
  return WIDGET_TITLES[id];
}

function listed(names: readonly string[]): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function clipped(text: string): string {
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;
}

/** The same text for the same value, as `jsonb` does not keep the order of the keys. */
function canonical(value: unknown): string {
  return (
    JSON.stringify(value, (_, part) =>
      part && typeof part === "object" && !Array.isArray(part)
        ? Object.fromEntries(Object.entries(part).toSorted(([a], [b]) => (a < b ? -1 : 1)))
        : part,
    ) ?? ""
  );
}

/** FNV-1a in two lanes: it tells states apart and protects nothing. */
function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}
