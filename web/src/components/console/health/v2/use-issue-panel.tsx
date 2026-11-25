"use client";

import { Panel, usePeek } from "@ratel/design-system/panel";
import { type ReactNode, useEffect, useState } from "react";
import { SIGNAL_OPEN_EVENT, signalAnchorFromHash } from "@/components/console/health/anchors";
import { IssueDetail } from "@/components/console/health/v2/IssueDetail";
import type { ExamplesCache } from "@/components/console/health/v2/IssueExamples";
import {
  ISSUE_TONE_LABEL,
  type IssueRow,
  issuePeek,
  peekedIssue,
  rowOfIssue,
} from "@/lib/views/health/issue-rows";

const SIGNAL_PREFIX = "signal-";

/**
 * The Panel of an issue list (`?peek=issue:<id>`): `j` and `k` step through `rows` while it is
 * open, and a `#signal-<id>` link opens the row it names.
 */
export function useIssuePanel({
  projectId,
  rows,
  examplesAllowed,
  upgradeHref,
  lockedPlan,
}: {
  projectId: string;
  /** In the order the reader steps through them. */
  rows: readonly IssueRow[];
  examplesAllowed: boolean;
  upgradeHref: string | null;
  lockedPlan: string | null;
}): {
  open: (row: IssueRow, turns?: boolean) => void;
  openRow: IssueRow | null;
  /** The open row's place in `rows`; -1 without one. */
  openIndex: number;
  panel: ReactNode;
} {
  const peek = usePeek();
  const openPeek = peek.open;
  const openId = peekedIssue(peek.id);
  const openRow = rowOfIssue(rows, openId);
  const openIndex = openRow ? rows.indexOf(openRow) : -1;
  const [fromTurns, setFromTurns] = useState<string | null>(null);
  // Keep the last row's body, on the member it was open on, while the panel animates out.
  const [shownRow, setShownRow] = useState<IssueRow | null>(openRow);
  const [shownId, setShownId] = useState<string | null>(openId);
  if (openRow && openRow !== shownRow) setShownRow(openRow);
  if (openId && openRow && openId !== shownId) setShownId(openId);
  // One cache for the page view: reopening an issue does not read its turns again.
  const [cache] = useState<ExamplesCache>(() => new Map());

  // A link that names one issue (`#signal-<id>`): open its row, on the member it names.
  useEffect(() => {
    const follow = (anchor: string | null) => {
      if (!anchor?.startsWith(SIGNAL_PREFIX)) return;
      const id = anchor.slice(SIGNAL_PREFIX.length);
      if (!rowOfIssue(rows, id)) return;
      openPeek(issuePeek(id));
    };
    const onHash = () => follow(signalAnchorFromHash(window.location.hash));
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      follow(typeof detail === "string" ? detail : null);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    window.addEventListener(SIGNAL_OPEN_EVENT, onRequest);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(SIGNAL_OPEN_EVENT, onRequest);
    };
  }, [rows, openPeek]);

  const open = (row: IssueRow, turns = false) => {
    setFromTurns(turns ? row.key : null);
    peek.open(row.peek);
  };
  const step = (by: 1 | -1) => {
    const next = rows[Math.min(rows.length - 1, Math.max(0, openIndex + by))];
    if (next && next !== openRow) open(next);
  };

  const panel = (
    <Panel
      open={openRow !== null}
      onOpenChange={(next) => {
        if (!next) peek.close();
      }}
      title={shownRow?.title ?? "Issue"}
      subtitle={
        shownRow
          ? `${ISSUE_TONE_LABEL[shownRow.tone]} · ${shownRow.figure.display} ${shownRow.figure.caption}`
          : undefined
      }
      onPrevious={openIndex > 0 ? () => step(-1) : undefined}
      onNext={openIndex >= 0 && openIndex < rows.length - 1 ? () => step(1) : undefined}
    >
      {shownRow ? (
        <IssueDetail
          key={`${shownRow.key}:${shownId ?? ""}`}
          projectId={projectId}
          row={shownRow}
          initialMemberId={shownId}
          examplesAllowed={examplesAllowed}
          upgradeHref={upgradeHref}
          lockedPlan={lockedPlan}
          focusExamples={fromTurns === shownRow.key}
          cache={cache}
        />
      ) : null}
    </Panel>
  );
  return { open, openRow, openIndex, panel };
}
