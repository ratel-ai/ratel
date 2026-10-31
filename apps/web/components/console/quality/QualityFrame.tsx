import { cn } from "@ratel/design-system/cn";
import { DotSpark } from "@ratel/design-system/dot-matrix";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { TabNav } from "@ratel/design-system/tabs";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  type EvidenceSourceLabel,
  type Headline,
  headlineNote,
  headlineValue,
} from "@/lib/views/quality/headline";
import { percent, type QualityTab, qualityTabLinks } from "@/lib/views/quality/model";

/**
 * Quality (DESIGN.md, One question per page): is the right tool ranked first,
 * and what should I change? The header carries the answer on every tab: the
 * headline share with its change and trend, the time window and the run menu.
 */
export function QualityFrame({
  projectId,
  tabs,
  search,
  meta,
  headline,
  actions,
  children,
}: {
  projectId: string;
  tabs: readonly QualityTab[];
  /** The window's query string, carried by every tab. */
  search: string;
  /** Counts after the tab labels. */
  meta?: Partial<Record<QualityTab, number>>;
  /** The headline line under the title; absent when match quality is off or not on the plan. */
  headline?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Page>
      <PageHeader
        title="Quality"
        description={headline}
        actions={actions}
        tabs={
          tabs.length > 1 ? (
            <TabNav
              label="Quality sections"
              tabs={qualityTabLinks(projectId, tabs, search, meta)}
            />
          ) : undefined
        }
      />
      <PageBody wide>{children}</PageBody>
    </Page>
  );
}

/**
 * "Right tool first 74%", its change against the window before, the trend and
 * the tier and searches it stands on; or, without enough judged searches, why
 * there is no number and what to do. Phrasing content only: it renders inside
 * the header's one-line description.
 */
export function HeadlineLine({
  headline,
  source,
  windowPhrase,
  versusPhrase,
  cut = null,
}: {
  headline: Headline;
  source: EvidenceSourceLabel;
  /** "the last 7 days". */
  windowPhrase: string;
  /** "vs the previous 7 days". */
  versusPhrase: string;
  /** How many searches one read takes, when this window held more than that. */
  cut?: number | null;
}) {
  const value = headlineValue(headline);
  const showTrend =
    headline.share !== null && headline.trend.filter((point) => point !== null).length >= 2;
  return (
    <span
      data-headline="right-tool-first"
      data-tier={headline.tier ?? "none"}
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      <span className="inline-flex items-baseline gap-2">
        <span>Right tool first</span>
        {value === null ? (
          <span className="text-xl font-semibold tracking-tight text-fg tabular-nums">
            {percent(headline.share)}
          </span>
        ) : (
          <span className="font-medium text-fg">{value}</span>
        )}
        {headline.change ? <ChangeChip change={headline.change} versus={versusPhrase} /> : null}
      </span>
      {showTrend ? (
        <DotSpark
          values={headline.trend}
          tone="neutral"
          label={`Right tool first per ${headline.trendUnit}, ${windowPhrase}. Blank ${headline.trendUnit}s had too few searches.`}
        />
      ) : null}
      <span className="text-xs text-fg-subtle tabular-nums">
        {headlineNote(headline, source, windowPhrase)}
        {cut !== null ? `, from the newest ${cut.toLocaleString("en-US")} in this window` : null}
      </span>
    </span>
  );
}

function ChangeChip({
  change,
  versus,
}: {
  change: NonNullable<Headline["change"]>;
  versus: string;
}) {
  const Icon =
    change.direction === "up"
      ? ArrowUpRight
      : change.direction === "down"
        ? ArrowDownRight
        : ArrowRight;
  // Up is good here: more searches had the right tool first.
  const tone =
    change.direction === "up"
      ? "text-success"
      : change.direction === "down"
        ? "text-danger"
        : "text-fg-subtle";
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 text-xs font-medium tabular-nums", tone)}
      title={versus}
    >
      <Icon className="size-3" aria-hidden />
      {change.text}
      <span className="sr-only"> {versus}</span>
    </span>
  );
}
