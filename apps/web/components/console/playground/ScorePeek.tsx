"use client";

import { cn } from "@ratel/design-system/cn";
import { Tooltip } from "@ratel/design-system/tooltip";
import type { ReactElement } from "react";
import {
  CATALOG_DESCRIPTIONS,
  CATALOG_DESCRIPTIONS_SAME,
  CATALOG_SEARCHABLE_SOURCE,
} from "@/lib/ingest/catalogs/vocabulary";
import type { ComparisonRow } from "@/lib/synthesis/playground/calibration-compare";
import type { RankedHit } from "@/lib/synthesis/playground/types";
import { formatRankScore, meterCells, sharePercent } from "@/lib/synthesis/playground/view";

/** What a row's score actually means, on hover. */

const METER_CELLS = 12;

export function PixelMeter({ fill, tone }: { fill: number; tone: "live" | "recorded" }) {
  const lit = meterCells(fill, METER_CELLS);
  return (
    <span className="inline-flex shrink-0 gap-px" aria-hidden>
      {Array.from({ length: METER_CELLS }, (_, index) => index).map((index) => (
        <span
          key={index}
          className={cn(
            "h-2 w-1 rounded-[1px]",
            index < lit ? (tone === "live" ? "bg-indigo-300" : "bg-cream-dim") : "bg-forest-300/50",
          )}
        />
      ))}
    </span>
  );
}

export function ScorePeek({
  row,
  hit,
  recorded,
  children,
}: {
  row: ComparisonRow;
  /** Live columns only: carries the description and the blend components. */
  hit: RankedHit | undefined;
  recorded: boolean;
  children: ReactElement;
}) {
  const matched = hit?.searchableDescription.trim() ?? "";
  const returned = hit?.description.trim() ?? "";
  // The ordinary case: ingest copied one into the other, so there is one text.
  const split = matched !== "" && returned !== "" && matched !== returned;
  // Nothing to add beyond what the row already shows.
  if (row.score === null && matched === "" && returned === "") return children;

  return (
    <Tooltip
      className="block max-w-xs rounded-lg border-forest-300 bg-base-deep/98 px-2.5 py-2 shadow-xl"
      content={
        <>
          <p className="truncate font-mono text-[11px] text-cream">{row.id}</p>

          {row.score !== null && (
            <div className="mt-1.5 flex items-center gap-2">
              <PixelMeter fill={row.fill} tone={recorded ? "recorded" : "live"} />
              <span className="font-mono text-[10px] tabular-nums text-cream-dim">
                {formatRankScore(row.score)}
              </span>
            </div>
          )}
          {row.score !== null && (
            <p className="mt-1 text-[10px] leading-snug text-warm-muted">
              {row.fill >= 1
                ? "Top result in this column"
                : `${sharePercent(row.fill)}% of the top result in this column`}
            </p>
          )}

          {hit && hit.bm25Score !== null && hit.embeddingScore !== null && (
            <p className="mt-1 font-mono text-[10px] tabular-nums text-warm-muted/80">
              bm25 {formatRankScore(hit.bm25Score)} · emb {formatRankScore(hit.embeddingScore)}
            </p>
          )}

          {split ? (
            <>
              <PeekText
                label={CATALOG_DESCRIPTIONS.searchable.label}
                owner={
                  (hit?.searchableDescriptionSource === "override"
                    ? CATALOG_SEARCHABLE_SOURCE.cloud
                    : CATALOG_SEARCHABLE_SOURCE.runtime
                  ).label
                }
                text={matched}
                tone="matched"
              />
              <PeekText label={CATALOG_DESCRIPTIONS.agent.label} text={returned} tone="returned" />
            </>
          ) : (
            matched !== "" && (
              <>
                <p className="mt-1.5 border-t border-forest-300/60 pt-1.5 text-[11px] leading-relaxed text-cream-dim">
                  {matched}
                </p>
                {hit && hit.searchableDescriptionSource !== "description" && (
                  <p className="mt-1 text-[10px] leading-snug text-warm-muted/80">
                    {CATALOG_DESCRIPTIONS_SAME}
                  </p>
                )}
              </>
            )
          )}
        </>
      }
    >
      {children}
    </Tooltip>
  );
}

/** One labelled text in the peek. */
function PeekText({
  label,
  owner,
  text,
  tone,
}: {
  label: string;
  /** Who owns this text, when that is a meaningful question. */
  owner?: string;
  text: string;
  tone: "matched" | "returned";
}) {
  return (
    <div className="mt-1.5 border-t border-forest-300/60 pt-1.5">
      <p
        className={cn(
          "font-mono text-[10px] uppercase tracking-wide",
          tone === "matched" ? "text-indigo-300/80" : "text-warm-muted/70",
        )}
      >
        {label}
        {owner && <span className="text-warm-muted/70"> · {owner}</span>}
      </p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-cream-dim">{text}</p>
    </div>
  );
}
