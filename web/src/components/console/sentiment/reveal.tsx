"use client";

import { cn } from "@ratel/design-system/cn";
import { type ReactNode, useRef, useState } from "react";

/**
 * Rows of a grouped table that fold under their heading with a reveal: the
 * state of which groups are open (`useReveal`), and the wrapper that grows a
 * cell's content from no height to its own and back (`Reveal`). Shared by the
 * tables grouped by reason (Root cause analysis) and by group
 * (Hallucinations); `Grow` alone is how a long list's next rows come in
 * (`turn-panel/SeeMoreList`).
 */

/** How long a group folds or opens, in ms; the CSS uses the same. */
const REVEAL_MS = 200;

/** Classes for a revealed row: its cells take their content's height, so it can animate. A closed one also drops its rule (`[&>td]:border-b-transparent`). */
export const REVEAL_ROW = "[&>td]:h-auto [&>td]:transition-[border-color] [&>td]:duration-200";

/**
 * Which lines are open, and which are still in the table: opening mounts a
 * line closed and opens it on the next frame, so it animates in; closing
 * animates it out and takes it away once `REVEAL_MS` has passed (unless it
 * was opened again meanwhile).
 */
export function useReveal(defaultOpen: boolean) {
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [mounted, setMounted] = useState<ReadonlyMap<string, boolean>>(new Map());
  // The close each line is waiting to finish: opening it again cancels the removal.
  const closing = useRef(new Map<string, number>());
  const set = (setter: typeof setOpen, key: string, value: boolean) =>
    setter((current) => new Map(current).set(key, value));
  const isOpen = (key: string) => open.get(key) ?? defaultOpen;
  const isMounted = (key: string) => mounted.get(key) ?? defaultOpen;
  const toggle = (key: string) => {
    if (isOpen(key)) {
      const token = (closing.current.get(key) ?? 0) + 1;
      closing.current.set(key, token);
      set(setOpen, key, false);
      window.setTimeout(() => {
        if (closing.current.get(key) === token) set(setMounted, key, false);
      }, REVEAL_MS);
    } else {
      closing.current.set(key, (closing.current.get(key) ?? 0) + 1);
      set(setMounted, key, true);
      requestAnimationFrame(() => requestAnimationFrame(() => set(setOpen, key, true)));
    }
  };
  return { isOpen, isMounted, toggle };
}

/** Content grown from no height to its own (and back), fading in and out. */
export function Grow({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        shown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** A cell's content, grown from no height to its own (and back) as its line opens and closes. */
export function Reveal({
  shown,
  align,
  children,
}: {
  shown: boolean;
  align?: "left" | "right";
  children: ReactNode;
}) {
  return (
    <Grow shown={shown}>
      <div className={cn("flex min-h-9 items-center", align === "right" && "justify-end")}>
        {children}
      </div>
    </Grow>
  );
}
