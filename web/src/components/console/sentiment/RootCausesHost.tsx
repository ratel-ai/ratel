"use client";

import { IconButton } from "@ratel/design-system/button";
import { Panel } from "@ratel/design-system/panel";
import { Skeleton } from "@ratel/design-system/states";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useTransition,
} from "react";
import { NO_CAUSE_LABEL } from "@/components/console/sentiment/copy";
import { RootCauseDetail, rootCauseKey } from "@/components/console/sentiment/RootCauseDetail";
import { type PanelTurn, useTurnPanel } from "@/components/console/turn-panel/useTurnPanel";
import { CAUSE_LABEL } from "@/lib/views/traces/sentiment/page-kinds";
import type { ReasonGroupView } from "@/lib/views/traces/sentiment/page-links";
import {
  ROOT_CAUSE_PEEK,
  ROOT_CAUSES_PARAM,
  withoutRootCauses,
} from "@/lib/views/traces/sentiment/page-paths";

const OpenRootCauses = createContext<((href: string) => void) | null>(null);

/** A link into Root cause analysis: inside a host page it opens the panel there at once; elsewhere it is a link. */
export function RootCauseLink({ href, onClick, ...rest }: ComponentProps<typeof Link>) {
  const open = useContext(OpenRootCauses);
  return (
    <Link
      {...rest}
      href={href}
      scroll={false}
      onClick={(event) => {
        onClick?.(event);
        if (!open || event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        open(String(href));
      }}
    />
  );
}

/**
 * Root cause analysis as a panel over its host page (Agent health, Sentiment
 * analysis): the reasons and their root causes, then, in the same panel, one
 * root cause, then one of its turns. What is open is in the address. It opens
 * on the click and fills when the server has read it; opening another of the
 * host's panels lets it go.
 */
export function RootCausesHost({
  content,
  groups,
  subtitle,
  now,
  turn,
  otherParam,
  children,
}: {
  /** The analysis, read on the server; null while the address does not open it. */
  content: ReactNode | null;
  groups: readonly ReasonGroupView[];
  subtitle: string;
  now: string;
  turn: PanelTurn | null;
  /** The parameter of the host page's own panel. */
  otherParam: string;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const search = useSearchParams();
  const router = useRouter();
  const [loading, startLoading] = useTransition();
  const open = search?.get(ROOT_CAUSES_PARAM) === "1";
  const other = search?.get(otherParam) ?? null;
  // The host's own panel when this one opened; another one since then takes over.
  const [opened, setOpened] = useState({ open, other });
  if (opened.open !== open) setOpened({ open, other });
  const replaced = open && opened.open && other !== null && opened.other !== other;

  const peekId = open ? (search?.get(ROOT_CAUSE_PEEK) ?? null) : null;
  const entries = groups.flatMap((group) =>
    group.rows.map((row) => ({ group, row, key: rootCauseKey(group, row) })),
  );
  const index = entries.findIndex((entry) => entry.key === peekId);
  const entry = index >= 0 ? entries[index] : undefined;
  const label = entry
    ? entry.row.cause
      ? CAUSE_LABEL[entry.row.cause]
      : NO_CAUSE_LABEL
    : "Root cause analysis";
  const panel = useTurnPanel({ turn: open ? turn : null, openId: peekId, backLabel: label });
  const inTurn = open && panel.inTurn;

  const replace = (query: string) =>
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  const close = () => replace(withoutRootCauses(window.location.search));
  useEffect(() => {
    if (replaced) close();
  });
  /** Another root cause, or back to the list with null; no server round trip. */
  const show = (key: string | null) => {
    const query = new URLSearchParams(window.location.search);
    if (key) query.set(ROOT_CAUSE_PEEK, key);
    else query.delete(ROOT_CAUSE_PEEK);
    replace(query.toString());
  };
  const step = (by: 1 | -1) => {
    const next = entries[index + by];
    if (next) show(next.key);
  };
  return (
    <OpenRootCauses.Provider
      value={(href) => startLoading(() => router.push(href, { scroll: false }))}
    >
      {children}
      <Panel
        open={(open || loading) && !replaced}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        size="wide"
        title={
          inTurn ? (
            panel.title
          ) : entry ? (
            <span className="flex min-w-0 items-center gap-2">
              <IconButton
                label="Back to Root cause analysis"
                size="icon-sm"
                icon={<ArrowLeft />}
                onClick={() => show(null)}
                data-root-cause-back=""
              />
              <span className="truncate">{label}</span>
            </span>
          ) : (
            label
          )
        }
        subtitle={inTurn || entry ? undefined : subtitle}
        actions={inTurn ? panel.actions : null}
        onPrevious={!inTurn && entry && index > 0 ? () => step(-1) : undefined}
        onNext={!inTurn && entry && index < entries.length - 1 ? () => step(1) : undefined}
      >
        {inTurn ? (
          panel.body
        ) : entry ? (
          <RootCauseDetail
            group={entry.group}
            row={entry.row}
            now={now}
            onOpenTurn={panel.onOpen}
          />
        ) : content && open ? (
          <div
            className={loading ? "opacity-60 transition-opacity duration-160" : undefined}
            data-root-causes=""
          >
            {content}
          </div>
        ) : (
          <div className="flex flex-col gap-4" aria-busy="true">
            <Skeleton className="h-24" />
            <Skeleton className="h-40" />
            <Skeleton className="h-56" />
          </div>
        )}
      </Panel>
    </OpenRootCauses.Provider>
  );
}
