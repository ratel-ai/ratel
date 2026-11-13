"use client";

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useCallback, useRef } from "react";
import { cn } from "../cn";
import { IconButton } from "./button";
import { canStep, eventFromInside, isTypingTarget, PEEK_PARAM, withPeek } from "./peek";

export type PanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** One quiet line under the title: an id, a time, a status word. */
  subtitle?: ReactNode;
  /** Header actions, e.g. an "Open full trace" link. */
  actions?: ReactNode;
  /** Wire these to step through the list underneath (`k` and `j`). */
  onPrevious?: () => void;
  onNext?: () => void;
  /** `wide` for a body built around a drawing that needs the room (an ask's workflow). */
  size?: "default" | "wide";
  children: ReactNode;
  className?: string;
};

/**
 * Inspect one item without leaving its list (DESIGN.md, Overlays). Slides in
 * from the right; focus stays inside it, but the page behind keeps scrolling
 * and a click on another row switches the panel rather than closing it.
 *
 * Keep passing the last item's title and body while `open` turns false: the
 * popup stays mounted for its exit animation and should not blank.
 */
export function Panel({
  open,
  onOpenChange,
  title,
  subtitle,
  actions,
  onPrevious,
  onNext,
  size = "default",
  children,
  className,
}: PanelProps) {
  const lastStepAt = useRef<number | null>(null);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!eventFromInside(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
    const step = event.key === "j" ? onNext : event.key === "k" ? onPrevious : undefined;
    if (!step) return;
    event.preventDefault();
    if (!canStep(event, lastStepAt.current)) return;
    lastStepAt.current = event.timeStamp;
    step();
  }

  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={onOpenChange}
      modal="trap-focus"
      disablePointerDismissal
    >
      <BaseDialog.Portal>
        <BaseDialog.Popup
          onKeyDown={onKeyDown}
          className={cn(
            "fixed inset-y-2 right-2 z-panel flex flex-col overflow-hidden rounded-xl border border-line bg-overlay text-fg shadow-dialog outline-none focus-visible:outline-none",
            size === "wide" ? "w-[min(48rem,calc(100vw-1rem))]" : "w-[min(36rem,calc(100vw-1rem))]",
            "transition-[translate,opacity] duration-200 ease-enter data-starting-style:translate-x-6 data-starting-style:opacity-0",
            "data-ending-style:translate-x-6 data-ending-style:opacity-0 data-ending-style:duration-120 data-ending-style:ease-exit motion-reduce:transition-none",
            className,
          )}
        >
          <header className="flex min-h-12 shrink-0 items-center gap-1 border-b border-line py-2 pr-2 pl-4">
            <div className="min-w-0 flex-1">
              <BaseDialog.Title className="truncate text-sm font-semibold text-fg">
                {title}
              </BaseDialog.Title>
              {subtitle ? (
                <BaseDialog.Description className="truncate text-xs text-fg-subtle">
                  {subtitle}
                </BaseDialog.Description>
              ) : null}
            </div>
            {actions ? <div className="mr-1 flex items-center gap-1">{actions}</div> : null}
            {onPrevious ? (
              <IconButton
                label="Previous"
                shortcut="K"
                size="icon-sm"
                icon={<ChevronUp />}
                onClick={onPrevious}
              />
            ) : null}
            {onNext ? (
              <IconButton
                label="Next"
                shortcut="J"
                size="icon-sm"
                icon={<ChevronDown />}
                onClick={onNext}
              />
            ) : null}
            <BaseDialog.Close
              render={<IconButton label="Close" shortcut="Esc" size="icon-sm" icon={<X />} />}
            />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/**
 * A link that opens a Panel in place. The `href` is a real `?peek=` URL, so a
 * new tab or a copied link lands with the Panel open, while a plain click only
 * rewrites the URL (no server round trip, no history entry, as `usePeek`).
 */
export function PeekLink({
  peek,
  param = PEEK_PARAM,
  className,
  children,
}: {
  peek: string;
  param?: string;
  className?: string;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const href = `${pathname}${withPeek(searchParams?.toString() ?? "", peek, param)}`;
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        window.history.replaceState(
          null,
          "",
          `${pathname}${withPeek(window.location.search, peek, param)}`,
        );
      }}
    >
      {children}
    </a>
  );
}

/**
 * The open Panel's id from the URL. Updates go through the History API, which
 * Next keeps in sync with `useSearchParams` without a server round trip, and
 * replace rather than push, so closing a peek does not take a Back press.
 */
export function usePeek(param: string = PEEK_PARAM) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const id = searchParams.get(param);
  const set = useCallback(
    (next: string | null) => {
      window.history.replaceState(
        null,
        "",
        `${pathname}${withPeek(window.location.search, next, param)}`,
      );
    },
    [pathname, param],
  );
  return {
    id,
    open: useCallback((next: string) => set(next), [set]),
    close: useCallback(() => set(null), [set]),
  };
}
