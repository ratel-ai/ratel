import {
  type ChangeSource,
  describeChange,
  describeRestore,
  describeUndo,
  type LayoutChangeEntry,
  type LayoutRecord,
  type LayoutWrite,
  NO_RECORD,
  nextChange,
  revisionOf,
  undoTarget,
} from "./domain/history";
import {
  defaultLayout,
  type OfferedWidgets,
  type OverviewLayout,
  sameLayout,
} from "./domain/layout";
import {
  changeArrangement,
  isUnreadable,
  layoutChangeSchema,
  type OverviewArrangement,
  readArrangement,
} from "./domain/stored";
import type { LayoutKey, OverviewLayoutStore } from "./ports/store";

/**
 * Reading, changing, undoing and restoring the Overview layout, for the web and for MCP alike. Who
 * asks is decided by the caller's boundary (the console scope, or the MCP credential) and comes in
 * as `LayoutReader`.
 */

export type LayoutReader =
  /** Somebody with access to the project. `restricted`: in a support session, which reads the default. */
  | { kind: "person"; projectId: string; personId: string; restricted: boolean }
  /** An API key is no person: it has no layout of its own. */
  | { kind: "api-key" };

export interface LayoutDeps {
  /** Null for somebody who is signed out or has no access to the project. */
  reader: (projectId: string) => Promise<LayoutReader | null>;
  store: () => OverviewLayoutStore;
  /** The widgets the project offers now, such as behind a flag. */
  offered: (projectId: string) => Promise<OfferedWidgets>;
  /** Where a change is made. */
  source: () => Promise<ChangeSource>;
}

/** The layout, the state it is of, and what an undo would take back. */
export interface LayoutSnapshot {
  layout: OverviewLayout;
  /** A change, an undo and a restore give it back, and are refused when it is not the latest. */
  revision: string;
  /** What Undo takes back, in plain words; null when there is nothing. */
  undo: string | null;
}

export interface LayoutHistoryEntry {
  id: number;
  kind: LayoutChangeEntry["kind"];
  personId: string;
  source: ChangeSource;
  at: Date;
  summary: string;
  /** The layout after it; null when this build cannot read it. */
  layout: OverviewLayout | null;
  /** The layout after it is what the person sees now, so there is nothing to restore. */
  current: boolean;
  /** False when this build cannot read its layout. */
  readable: boolean;
}

export type LayoutRefusal =
  | "not_found"
  | "api_key"
  | "support_session"
  | "invalid"
  | "unreadable"
  | "stale"
  | "nothing_to_undo"
  | "not_kept"
  | "unreadable_entry";

/** `current`: with `stale`, what is there now. */
export type LayoutRefused = { ok: false; reason: LayoutRefusal; current?: LayoutSnapshot };

export type LayoutResult = ({ ok: true } & LayoutSnapshot) | LayoutRefused;

export type LayoutChangeResult =
  /** `changed`: what the new entry says; null when the layout was that one already. */
  ({ ok: true; changed: string | null } & LayoutSnapshot) | LayoutRefused;

export type LayoutHistoryResult =
  | { ok: true; entries: LayoutHistoryEntry[]; snapshot: LayoutSnapshot }
  | LayoutRefused;

export const LAYOUT_REFUSALS: Readonly<Record<LayoutRefusal, string>> = {
  not_found: "No project you belong to has that ID.",
  api_key:
    "An API key has no Overview layout. Sign in to the MCP server as a person to use the layout.",
  support_session: "A support session cannot change the Overview or read its history.",
  invalid: "That is not a change the Overview can make.",
  unreadable:
    "This version of Ratel cannot read the saved layout, so it stays as it is. Reset the layout to start again from the default.",
  stale: "The layout changed in another place. Nothing was overwritten.",
  nothing_to_undo: "There is no change to take back.",
  not_kept: "That change is not in the history. The history keeps the last 25 changes.",
  unreadable_entry:
    "This version of Ratel cannot read the layout of that change, so the layout stays as it is.",
};

export async function readOverviewLayout(
  projectId: string,
  deps: LayoutDeps,
): Promise<LayoutResult> {
  const reader = await deps.reader(projectId);
  if (!reader) return { ok: false, reason: "not_found" };
  const offered = await deps.offered(projectId);
  if (reader.kind === "api-key" || reader.restricted)
    return { ok: true, ...snapshotOf(NO_RECORD, offered) };
  return { ok: true, ...snapshotOf(await deps.store().read(reader), offered) };
}

/** `base`: the revision the person saw. Null applies the change to what is there now. */
export function changeOverviewLayout(
  projectId: string,
  change: unknown,
  deps: LayoutDeps,
  base: string | null,
): Promise<LayoutChangeResult> {
  return write(projectId, deps, base, (offered) => {
    const parsed = layoutChangeSchema(offered).safeParse(change);
    if (!parsed.success) return "invalid";
    return (record) => {
      // Only a reset, which asks for it, replaces what cannot be read.
      if (isUnreadable(record.layout) && parsed.data.kind !== "reset") return "unreadable";
      const before = readArrangement(record.layout, offered);
      const next = changeArrangement(before, parsed.data, offered);
      return {
        next,
        kind: "change",
        summary: describeChange(parsed.data, before.layout, next.layout),
      };
    };
  });
}

/** Takes back the latest change that is not taken back yet, as a new entry. */
export function undoOverviewChange(
  projectId: string,
  deps: LayoutDeps,
  base: string,
): Promise<LayoutChangeResult> {
  return write(projectId, deps, base, (offered) => (record) => {
    if (isUnreadable(record.layout)) return "unreadable";
    const target = undoTarget(record);
    if (!target) return "nothing_to_undo";
    const next = keptArrangement(target.layout, offered);
    return (
      (next && { next, kind: "undo", summary: describeUndo(target), undoes: target.seq }) ??
      "unreadable_entry"
    );
  });
}

/** Goes back to the layout after one kept entry, as a new entry. */
export function restoreOverviewLayout(
  projectId: string,
  entryId: number,
  deps: LayoutDeps,
  base: string,
): Promise<LayoutChangeResult> {
  return write(projectId, deps, base, (offered) => (record) => {
    if (isUnreadable(record.layout)) return "unreadable";
    const entry = record.entries.find(({ seq }) => seq === entryId);
    if (!entry) return "not_kept";
    const next = keptArrangement(entry.layout, offered);
    return (
      (next && { next, kind: "restore", summary: describeRestore(entry) }) ?? "unreadable_entry"
    );
  });
}

/** Only the person's own, newest first. */
export async function readOverviewHistory(
  projectId: string,
  deps: LayoutDeps,
): Promise<LayoutHistoryResult> {
  const reader = await deps.reader(projectId);
  const key = ownerOf(reader);
  if (typeof key === "string") return { ok: false, reason: key };
  const offered = await deps.offered(projectId);
  const record = await deps.store().read(key);
  const now = isUnreadable(record.layout) ? null : readArrangement(record.layout, offered).layout;
  return {
    ok: true,
    snapshot: snapshotOf(record, offered),
    entries: record.entries.map(({ seq, kind, source, at, summary, layout: stored }) => {
      const layout = keptArrangement(stored, offered)?.layout ?? null;
      return {
        id: seq,
        kind,
        personId: key.personId,
        source,
        at,
        summary,
        layout,
        readable: layout !== null,
        current: now !== null && layout !== null && sameLayout(layout, now),
      };
    }),
  };
}

// — Helpers ——————————————————————————————————————————————————————————————————

type Planned = Pick<LayoutWrite, "kind" | "summary"> & {
  next: OverviewArrangement;
  undoes?: number | null;
};

/** The one way to the store's write: who may, then under the lock the base, then the change. */
async function write(
  projectId: string,
  deps: LayoutDeps,
  base: string | null,
  prepare: (
    offered: OfferedWidgets,
  ) => ((record: LayoutRecord) => Planned | LayoutRefusal) | LayoutRefusal,
): Promise<LayoutChangeResult> {
  const key = ownerOf(await deps.reader(projectId));
  if (typeof key === "string") return { ok: false, reason: key };
  const offered = await deps.offered(projectId);
  const plan = prepare(offered);
  if (typeof plan === "string") return { ok: false, reason: plan };
  const source = await deps.source();
  let refusal: LayoutRefusal | null = null;
  let changed: string | null = null;
  const record = await deps.store().update(key, (current) => {
    if (base !== null && base !== revisionOf(current)) {
      refusal = "stale";
      return null;
    }
    const planned = plan(current);
    if (typeof planned === "string") {
      refusal = planned;
      return null;
    }
    const { next, ...what } = planned;
    const entry = nextChange(current, next, offered, { ...what, source });
    changed = entry?.summary ?? null;
    return entry;
  });
  const snapshot = snapshotOf(record, offered);
  if (refusal === "stale") return { ok: false, reason: refusal, current: snapshot };
  return refusal ? { ok: false, reason: refusal } : { ok: true, changed, ...snapshot };
}

function ownerOf(reader: LayoutReader | null): LayoutKey | LayoutRefusal {
  if (!reader) return "not_found";
  if (reader.kind === "api-key") return "api_key";
  if (reader.restricted) return "support_session";
  return { projectId: reader.projectId, personId: reader.personId };
}

function snapshotOf(record: LayoutRecord, offered: OfferedWidgets): LayoutSnapshot {
  const target = isUnreadable(record.layout) ? null : undoTarget(record);
  return {
    layout: readArrangement(record.layout, offered).layout,
    revision: revisionOf(record),
    undo: target && keptArrangement(target.layout, offered) ? target.summary : null,
  };
}

/** The arrangement of a kept value: null is the default. Null when this build cannot read it. */
function keptArrangement(stored: unknown, offered: OfferedWidgets): OverviewArrangement | null {
  if (stored === null) return { layout: defaultLayout(offered), kept: [] };
  return isUnreadable(stored) ? null : readArrangement(stored, offered);
}
