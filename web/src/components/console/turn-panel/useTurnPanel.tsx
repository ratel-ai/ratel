"use client";

import { IconButton } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { Callout, Skeleton } from "@ratel/design-system/states";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import {
  CALL_PEEK,
  peekedTurnId,
  TURN_PEEK,
  type TurnPeek,
  withTurnPeek,
} from "@/lib/views/traces/turn-peek";

/** A turn opened beside a list: what Traces shows of it, and its own page. */
export interface PanelTurn {
  id: string;
  href: string;
  /** Null when the turn could not be read. */
  view: ReactNode | null;
}

/**
 * A list's Panel that also shows one of its turns: the turn takes the Panel's
 * place (wide, with a way back and its full page), scrolled to the call it is
 * about. The turn is in the address, so a link reproduces it. Opening another
 * item of the list lets go of the turn: the Panel shows what was clicked last.
 */
export function useTurnPanel({
  turn,
  openId,
  backLabel,
}: {
  turn: PanelTurn | null;
  /** The list's open item. */
  openId: string | null;
  backLabel: string;
}) {
  const pathname = usePathname() ?? "";
  // Read as the server reads it: an id that is not one opens no turn, so the Panel never waits for it.
  const turnId = peekedTurnId(useSearchParams()?.get(TURN_PEEK));
  const router = useRouter();
  const [loading, startLoading] = useTransition();
  const body = useRef<HTMLDivElement>(null);
  // The item the turn was opened from; another item since then means the turn is left over.
  const [opened, setOpened] = useState({ turnId, openId });
  if (opened.turnId !== turnId) setOpened({ turnId, openId });
  const left = turnId !== null && opened.turnId === turnId && opened.openId !== openId;
  const inTurn = loading || (turnId !== null && !left);
  const shown = turn && turn.id === turnId && !loading && !left ? turn : null;
  const shownId = shown?.id ?? null;
  useEffect(() => {
    if (shownId)
      body.current?.querySelector('[data-focused="true"]')?.scrollIntoView({ block: "center" });
  }, [shownId]);
  /** The address with some of what it opens taken out; no server round trip. */
  const without = (params: readonly string[]) => {
    const query = new URLSearchParams(window.location.search);
    for (const param of params) query.delete(param);
    const text = query.toString();
    window.history.replaceState(null, "", text ? `${pathname}?${text}` : pathname);
  };
  useEffect(() => {
    if (left) without([TURN_PEEK, CALL_PEEK]);
  });
  const open = (peek: TurnPeek) =>
    startLoading(() =>
      router.push(`${pathname}${withTurnPeek(window.location.search, peek)}`, { scroll: false }),
    );
  return {
    inTurn,
    /** Closes the Panel: the turn, its call, and the list's own open item. */
    close: (listParam: string) => without([listParam, TURN_PEEK, CALL_PEEK]),
    /** A plain click shows the turn right here; a new tab or window opens the link. */
    onOpen: (peek: TurnPeek) => (event: MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open(peek);
    },
    title: (
      <span className="flex min-w-0 items-center gap-2">
        <IconButton
          label={`Back to ${backLabel}`}
          size="icon-sm"
          icon={<ArrowLeft />}
          onClick={() => without([TURN_PEEK, CALL_PEEK])}
          data-turn-panel-back=""
        />
        <span className="truncate">Turn in Traces</span>
      </span>
    ),
    actions: shown ? (
      <Link href={shown.href} className={buttonVariants({ variant: "ghost", size: "sm" })}>
        Open full page
        <ArrowUpRight aria-hidden />
      </Link>
    ) : null,
    body: (
      <div ref={body} data-turn-panel={shownId ?? "loading"}>
        {shown ? (
          (shown.view ?? (
            <Callout title="This turn couldn't be read">
              Try again in a moment, or open its full page.
            </Callout>
          ))
        ) : (
          <div className="flex flex-col gap-4" aria-busy="true">
            <Skeleton className="h-16" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        )}
      </div>
    ),
  };
}
