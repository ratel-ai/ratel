"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogContent } from "@ratel/design-system/dialog";
import { Callout, EmptyState, Skeleton } from "@ratel/design-system/states";
import { History } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { HISTORY_ID } from "@/components/console/home/focused/edit-mode";
import { LayoutHistoryList } from "@/components/console/home/focused/LayoutHistoryList";
import {
  type LayoutHistory,
  useOverviewLayout,
} from "@/components/console/home/focused/OverviewLayout";
import type { LayoutHistoryEntry } from "@/lib/views/overview-layout/actions";

/** The last changes of the person's layout, and Restore on each one. */
export function HistoryDialog() {
  const { browsing, setBrowsing, said } = useOverviewLayout();
  return (
    <Dialog
      open={browsing}
      onOpenChange={setBrowsing}
      onOpenChangeComplete={(open) => {
        if (!open) document.getElementById(HISTORY_ID)?.focus({ preventScroll: true });
      }}
    >
      <DialogContent
        title="History"
        description="The last 25 changes of your layout. Only you see them."
      >
        {/* Inside the popup, so every open reads the history again. */}
        <HistoryRead />
        <span className="sr-only" aria-live="polite">
          {said}
        </span>
      </DialogContent>
    </Dialog>
  );
}

function HistoryRead() {
  const { readHistory, restore } = useOverviewLayout();
  const [history, setHistory] = useState<LayoutHistory | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [notice, setNotice] = useState<HistoryNotice | null>(null);

  const read = useCallback(async () => setHistory(await readHistory()), [readHistory]);
  useEffect(() => {
    void read();
  }, [read]);

  async function onRestore(entry: LayoutHistoryEntry) {
    setRestoring(entry.id);
    setNotice(null);
    const result = await restore(entry.id);
    if (!result.ok)
      setNotice(result.current ? { kind: "stale" } : { kind: "failed", message: result.message });
    await read();
    setRestoring(null);
  }

  return (
    <HistoryBody
      history={history}
      notice={notice}
      restoring={restoring}
      now={new Date()}
      onRestore={(entry) => void onRestore(entry)}
      onRetry={() => {
        setHistory(null);
        void read();
      }}
    />
  );
}

export type HistoryNotice = { kind: "stale" } | { kind: "failed"; message: string };

export function HistoryBody({
  history,
  notice,
  restoring,
  now,
  onRestore,
  onRetry,
}: {
  /** Null while it is read. */
  history: LayoutHistory | null;
  notice: HistoryNotice | null;
  /** The entry that is on its way back. */
  restoring: number | null;
  now: Date;
  onRestore: (entry: LayoutHistoryEntry) => void;
  onRetry: () => void;
}): ReactNode {
  if (!history)
    return (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">Loading the history</span>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-9 w-full" />
        ))}
      </div>
    );
  if (!history.ok)
    return (
      <Callout
        tone="danger"
        title="The history did not load"
        action={
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        {history.message}
      </Callout>
    );
  return (
    <>
      {notice?.kind === "stale" ? (
        <Callout tone="warning" title="The layout changed in another place">
          Nothing was restored. This is the latest history.
        </Callout>
      ) : notice ? (
        <Callout tone="danger" title="The layout was not restored">
          {notice.message}
        </Callout>
      ) : null}
      {history.entries.length === 0 ? (
        <EmptyState
          icon={History}
          title="No changes yet"
          description="Each change of the layout shows here, with a way back to it."
          className="py-6"
        />
      ) : (
        <LayoutHistoryList
          entries={history.entries}
          now={now}
          action={(entry) =>
            entry.layout ? (
              <Button
                size="sm"
                className="max-lg:h-9"
                loading={restoring === entry.id}
                disabled={restoring !== null && restoring !== entry.id}
                focusableWhenDisabled
                aria-label={`Restore the layout after: ${entry.summary}`}
                onClick={() => onRestore(entry)}
              >
                Restore
              </Button>
            ) : (
              <span className="shrink-0 text-xs text-fg-subtle">Made by a newer version</span>
            )
          }
        />
      )}
    </>
  );
}
