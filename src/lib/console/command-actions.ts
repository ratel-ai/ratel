import type { EditionCommandAction } from "@/lib/contracts/composition";

/** A palette action as the command menu runs it. */
export type ConsoleCommandAction = {
  id: string;
  label: string;
  group: string;
  keywords?: readonly string[];
  run: () => void;
};

const OWN_IDS = new Set(["shortcuts", "sidebar"]);

function dispatchWindowEvent(event: string): void {
  window.dispatchEvent(new Event(event));
}

/**
 * The ⌘K actions: the edition's first, in its order (upstream lists Send feedback there), then
 * Keyboard shortcuts and the sidebar toggle. An edition action only dispatches its window event,
 * so the overlay that answers it stays the edition's. Without an edition, the console's two.
 */
export function consoleCommandActions({
  edition = [],
  collapsed,
  openShortcuts,
  toggleCollapsed,
  dispatch = dispatchWindowEvent,
}: {
  edition?: readonly EditionCommandAction[];
  collapsed: boolean;
  openShortcuts: () => void;
  toggleCollapsed: () => void;
  dispatch?: (event: string) => void;
}): ConsoleCommandAction[] {
  return [
    ...edition
      .filter(({ id }) => !OWN_IDS.has(id))
      .map(({ id, label, keywords, event }) => ({
        id,
        label,
        group: "Actions",
        ...(keywords ? { keywords } : {}),
        run: () => dispatch(event),
      })),
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      group: "Actions",
      keywords: ["keys", "hotkeys", "help"],
      run: openShortcuts,
    },
    {
      id: "sidebar",
      label: collapsed ? "Expand sidebar" : "Collapse sidebar",
      group: "Actions",
      keywords: ["rail", "menu"],
      run: toggleCollapsed,
    },
  ];
}
