"use client";

import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { offeredTo } from "@/components/console/home/focused/widgets";
import type { LayoutHistoryEntry, LayoutSnapshot } from "@/lib/views/overview-layout/actions";
import { isEarlier } from "@/lib/views/overview-layout/domain/history";
import {
  changeLayout,
  type OverviewLayout,
  type OverviewLayoutChange,
  type OverviewWidgetId,
  sameLayout,
} from "@/lib/views/overview-layout/domain/layout";

/** `current`: the layout changed in another place, and this is it. */
type Refused = { ok: false; message: string; current?: LayoutSnapshot };
type Saved = ({ ok: true; changed: string | null } & LayoutSnapshot) | Refused;
export type LayoutHistory =
  | { ok: true; entries: LayoutHistoryEntry[]; snapshot: LayoutSnapshot }
  | Refused;

/** The server actions, bound to the project. `base` is the revision that the page shows. */
export interface LayoutActions {
  save: (change: OverviewLayoutChange, base: string) => Promise<Saved>;
  undo: (base: string) => Promise<Saved>;
  restore: (entryId: number, base: string) => Promise<Saved>;
  history: () => Promise<LayoutHistory>;
}

interface LayoutState {
  layout: OverviewLayout;
  editable: boolean;
  /** Edit mode: in this page only. A reload is view mode. */
  editing: boolean;
  setEditing: (editing: boolean) => void;
  /** The Add widget dialog. */
  adding: boolean;
  setAdding: (adding: boolean) => void;
  /** The widgets of the last visit to the dialog, until the page has shown them. */
  added: readonly OverviewWidgetId[];
  setAdded: (added: readonly OverviewWidgetId[]) => void;
  /** A save is on its way. */
  saving: boolean;
  /** Applies at once, then saves. `said` is for a screen reader. The number names this change. */
  change: (change: OverviewLayoutChange, said?: string) => number;
  /** What Undo takes back, in plain words; null when there is nothing. */
  undoable: string | null;
  /** Takes back the latest change. With `only`, another change after that one puts `otherwise` instead. */
  undo: (only?: { change: number; otherwise: OverviewLayoutChange }) => void;
  restore: (entryId: number) => Promise<Saved>;
  /** After the changes that wait. */
  readHistory: () => Promise<LayoutHistory>;
  /** The History dialog. */
  browsing: boolean;
  setBrowsing: (browsing: boolean) => void;
  said: string;
}

const LayoutContext = createContext<LayoutState | null>(null);

/**
 * The layout as this page shows it, and whether the person edits it. A change is drawn at once and
 * saved once; saves run one after another, each on the revision of the one before it. A save that
 * fails puts back the last saved layout and says so. A layout that changed in another place is
 * shown, never overwritten, and the changes that wait are dropped, as they were made on the old one.
 */
export function OverviewLayoutProvider({
  initial,
  actions,
  startEditing = false,
  children,
}: {
  initial: LayoutSnapshot;
  /** Null where nobody may change the layout. */
  actions: LayoutActions | null;
  /** Draws edit mode at first, in a test. */
  startEditing?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [layout, setLayout] = useState(initial.layout);
  const [undoable, setUndoable] = useState(initial.undo);
  const [editing, setEditMode] = useState(startEditing);
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [added, setAdded] = useState<readonly OverviewWidgetId[]>([]);
  const [said, setSaid] = useState("");
  const [pending, setPending] = useState(0);
  const saved = useRef<LayoutSnapshot>(initial);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const waiting = useRef(0);
  /** Counts what the person did, to name the latest change. */
  const changes = useRef(0);
  /** Goes up when the changes that wait are dropped. */
  const line = useRef(0);

  // A fresh render of the server's: another tab or an agent may have changed the layout. The one
  // of an earlier save can come late.
  const { layout: served, revision, undo: servedUndo } = initial;
  useEffect(() => {
    const known = saved.current;
    if (pending > 0 || isEarlier(revision, known.revision)) return;
    if (revision === known.revision && sameLayout(served, known.layout)) return;
    saved.current = { layout: served, revision, undo: servedUndo };
    setLayout(served);
    setUndoable(servedUndo);
  }, [served, revision, servedUndo, pending]);

  // A change that waits would be lost with the page, and its entry too.
  useEffect(() => {
    if (pending === 0) return;
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [pending]);

  const setEditing = useCallback((next: boolean) => {
    setEditMode(next);
    setAdding(false);
    setBrowsing(false);
    setAdded([]);
    setSaid(next ? "Edit mode. Add, move, resize or remove widgets." : "Edit mode is off.");
  }, []);

  /** Runs a write after the ones before it, on the revision they left. */
  const enqueue = useCallback(
    (write: (base: string) => Promise<Saved>): Promise<Saved> => {
      changes.current += 1;
      waiting.current += 1;
      setPending((count) => count + 1);
      const mine = line.current;
      const run = async (): Promise<Saved> => {
        if (mine !== line.current) return DROPPED;
        const result = await write(saved.current.revision).catch(() => FAILED);
        if (result.ok || result.current) {
          const { layout, revision, undo } = result.ok
            ? result
            : (result.current as LayoutSnapshot);
          saved.current = { layout, revision, undo };
          setUndoable(undo);
        }
        if (!result.ok && result.current) {
          line.current += 1;
          // A widget that came back in another place has no body on this page yet.
          router.refresh();
        }
        if (!result.ok) {
          // Nothing was saved, so there is no change of this page's to take back.
          changes.current += 1;
          setLayout(saved.current.layout);
          setSaid("");
        } else if (waiting.current === 1) {
          // Nothing else is drawn on top of it.
          setLayout(result.layout);
        }
        return result;
      };
      const done = queue.current.then(run).finally(() => {
        waiting.current -= 1;
        setPending((count) => count - 1);
      });
      queue.current = done;
      return done;
    },
    [router],
  );

  const change = useCallback(
    (next: OverviewLayoutChange, announcement = "") => {
      if (!actions) return changes.current;
      setLayout((current) => changeLayout(current, next, offeredTo(current)));
      setSaid(announcement);
      void enqueue((base) => actions.save(next, base)).then(report);
      return changes.current;
    },
    [actions, enqueue],
  );

  const undo = useCallback(
    (only?: { change: number; otherwise: OverviewLayoutChange }) => {
      if (!actions) return;
      if (only && only.change !== changes.current) {
        change(only.otherwise);
        return;
      }
      void enqueue((base) => actions.undo(base)).then((result) => {
        if (result.ok && result.changed) setSaid(result.changed);
        report(result);
      });
    },
    [actions, change, enqueue],
  );

  const restore = useCallback(
    async (entryId: number) => {
      if (!actions) return FAILED;
      const result = await enqueue((base) => actions.restore(entryId, base));
      if (result.ok && result.changed) setSaid(result.changed);
      return result;
    },
    [actions, enqueue],
  );

  const readHistory = useCallback(async () => {
    if (!actions) return FAILED;
    await queue.current;
    const result = await actions.history().catch(() => FAILED);
    // What the list shows is what the page shows, so Restore is on the list that was read.
    if (result.ok && waiting.current === 0 && result.snapshot.revision !== saved.current.revision) {
      changes.current += 1;
      router.refresh();
      saved.current = result.snapshot;
      setLayout(result.snapshot.layout);
      setUndoable(result.snapshot.undo);
    }
    return result;
  }, [actions, router]);

  const editable = actions !== null;
  const state = useMemo(
    () => ({
      layout,
      editable,
      editing: editable && editing,
      setEditing,
      adding: editable && editing && adding,
      setAdding,
      browsing: editable && editing && browsing,
      setBrowsing,
      added,
      setAdded,
      saving: pending > 0,
      change,
      undoable,
      undo,
      restore,
      readHistory,
      said,
    }),
    [
      layout,
      editable,
      editing,
      setEditing,
      adding,
      browsing,
      added,
      pending,
      change,
      undoable,
      undo,
      restore,
      readHistory,
      said,
    ],
  );
  return (
    <LayoutContext.Provider value={state}>
      {children}
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </LayoutContext.Provider>
  );
}

export function useOverviewLayout(): LayoutState {
  const state = useContext(LayoutContext);
  if (!state) throw new Error("useOverviewLayout is used outside OverviewLayoutProvider");
  return state;
}

const FAILED: Refused = { ok: false, message: "The server did not answer." };
/** It waited behind a change that was refused as stale, which is what the person reads. */
const DROPPED: Refused = { ok: false, message: "" };

function report(result: Saved) {
  if (result.ok || result === DROPPED) return;
  toast(
    result.current
      ? {
          title: "The layout changed in another place",
          description: "This is the latest layout. Your last change was not saved.",
        }
      : {
          title: "The layout was not saved",
          description: `${result.message} The last saved layout is back.`,
          tone: "danger",
        },
  );
}
