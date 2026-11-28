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
  useState,
} from "react";
import {
  createLayoutQueue,
  DROPPED,
  FAILED,
  type Refused,
  type Saved,
} from "@/components/console/home/focused/layout-queue";
import { offeredTo } from "@/components/console/home/focused/widgets";
import type { LayoutHistoryEntry, LayoutSnapshot } from "@/lib/views/overview-layout/actions";
import type { OfferedDashboard } from "@/lib/views/overview-layout/dashboard-widgets";
import {
  changeLayout,
  type OverviewItemId,
  type OverviewLayout,
  type OverviewLayoutChange,
} from "@/lib/views/overview-layout/domain/layout";

export type LayoutHistory =
  | { ok: true; entries: LayoutHistoryEntry[]; snapshot: LayoutSnapshot }
  | Refused;

export type DashboardWidgetsRead =
  | { ok: true; dashboards: OfferedDashboard[] }
  | { ok: false; message: string };

/** The server actions, bound to the project. `base` is the revision that the page shows. */
export interface LayoutActions {
  save: (change: OverviewLayoutChange, base: string) => Promise<Saved>;
  undo: (base: string) => Promise<Saved>;
  restore: (entryId: number, base: string) => Promise<Saved>;
  history: () => Promise<LayoutHistory>;
  /** What the dashboards offer. */
  dashboardWidgets: () => Promise<DashboardWidgetsRead>;
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
  added: readonly OverviewItemId[];
  setAdded: (added: readonly OverviewItemId[]) => void;
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
  /** Null where the Overview takes no dashboard widget. */
  readDashboardWidgets: LayoutActions["dashboardWidgets"] | null;
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
 * shown, never overwritten, and the changes that wait are dropped, as they were made on the old one
 * (`layout-queue.ts`).
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
  const [added, setAdded] = useState<readonly OverviewItemId[]>([]);
  const [said, setSaid] = useState("");
  const [pending, setPending] = useState(0);
  const [queue] = useState(() =>
    createLayoutQueue(initial, {
      show: setLayout,
      undoable: setUndoable,
      pending: setPending,
      refused: () => setSaid(""),
      changedElsewhere: () => router.refresh(),
    }),
  );

  // Another tab or an agent may have changed the layout.
  const { layout: served, revision, undo: servedUndo } = initial;
  useEffect(() => {
    if (pending === 0) queue.served({ layout: served, revision, undo: servedUndo });
  }, [queue, served, revision, servedUndo, pending]);

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

  const change = useCallback(
    (next: OverviewLayoutChange, announcement = "") => {
      if (!actions) return queue.latest();
      setLayout((current) => changeLayout(current, next, offeredTo(current)));
      setSaid(announcement);
      void queue.enqueue((base) => actions.save(next, base)).then(report);
      return queue.latest();
    },
    [actions, queue],
  );

  const undo = useCallback(
    (only?: { change: number; otherwise: OverviewLayoutChange }) => {
      if (!actions) return;
      if (only && only.change !== queue.latest()) {
        change(only.otherwise);
        return;
      }
      void queue
        .enqueueUndo((base) => actions.undo(base))
        .then((result) => {
          if (result.ok && result.changed) setSaid(result.changed);
          report(result);
        });
    },
    [actions, change, queue],
  );

  const restore = useCallback(
    async (entryId: number) => {
      if (!actions) return FAILED;
      const result = await queue.enqueue((base) => actions.restore(entryId, base));
      if (result.ok && result.changed) setSaid(result.changed);
      return result;
    },
    [actions, queue],
  );

  const readHistory = useCallback(async () => {
    if (!actions) return FAILED;
    await queue.idle();
    const result = await actions.history().catch(() => FAILED);
    if (result.ok) queue.read(result.snapshot);
    return result;
  }, [actions, queue]);

  const editable = actions !== null;
  const readDashboardWidgets = actions?.dashboardWidgets ?? null;
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
      readDashboardWidgets,
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
      readDashboardWidgets,
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
