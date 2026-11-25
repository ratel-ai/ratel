"use client";

import { toast } from "@ratel/design-system/toast";
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
import {
  changeLayout,
  type OverviewLayout,
  type OverviewLayoutChange,
  sameLayout,
} from "@/lib/views/overview-layout/domain/layout";

/** The server action, bound to the project. Null where nobody may change the layout. */
export type SaveLayout = (
  change: OverviewLayoutChange,
) => Promise<{ ok: true; layout: OverviewLayout } | { ok: false; message: string }>;

interface LayoutState {
  layout: OverviewLayout;
  editable: boolean;
  /** Edit mode: in this page only. A reload is view mode. */
  editing: boolean;
  setEditing: (editing: boolean) => void;
  /** The Add widget dialog. */
  adding: boolean;
  setAdding: (adding: boolean) => void;
  /** Applies at once, then saves. `said` is for a screen reader. */
  change: (change: OverviewLayoutChange, said?: string) => void;
  said: string;
}

const LayoutContext = createContext<LayoutState | null>(null);

/**
 * The layout as this page shows it, and whether the person edits it. A change is drawn at once and
 * saved once; saves run one after another. A save that fails puts back the last saved layout and
 * says so.
 */
export function OverviewLayoutProvider({
  initial,
  save,
  startEditing = false,
  children,
}: {
  initial: OverviewLayout;
  save: SaveLayout | null;
  /** Draws edit mode at first, in a test. */
  startEditing?: boolean;
  children: ReactNode;
}) {
  const [layout, setLayout] = useState(initial);
  const [editing, setEditMode] = useState(startEditing);
  const [adding, setAdding] = useState(false);
  const [said, setSaid] = useState("");
  const [seen, setSeen] = useState(initial);
  const [pending, setPending] = useState(0);
  const saved = useRef(initial);
  const queue = useRef<Promise<void>>(Promise.resolve());

  // A fresh render of the server's: another tab or an agent may have changed the layout.
  if (!sameLayout(seen, initial) && pending === 0) {
    setSeen(initial);
    setLayout(initial);
  }

  useEffect(() => {
    saved.current = initial;
  }, [initial]);

  const setEditing = useCallback((next: boolean) => {
    setEditMode(next);
    setSaid(next ? "Edit mode. Add, move, resize or remove widgets." : "Edit mode is off.");
  }, []);

  const change = useCallback(
    (next: OverviewLayoutChange, announcement = "") => {
      if (!save) return;
      setLayout((current) => changeLayout(current, next, offeredTo(current)));
      setSaid(announcement);
      setPending((count) => count + 1);
      queue.current = queue.current.then(async () => {
        const result = await save(next).catch(() => FAILED);
        if (result.ok) {
          saved.current = result.layout;
        } else {
          setLayout(saved.current);
          setSaid("");
          toast({
            title: "The layout was not saved",
            description: `${result.message} The last saved layout is back.`,
            tone: "danger",
          });
        }
        setPending((count) => count - 1);
      });
    },
    [save],
  );
  const editable = save !== null;
  const state = useMemo(
    () => ({
      layout,
      editable,
      editing: editable && editing,
      setEditing,
      adding: editable && editing && adding,
      setAdding,
      change,
      said,
    }),
    [layout, editable, editing, setEditing, adding, change, said],
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

const FAILED = { ok: false, message: "The server did not answer." } as const;
