import { NounIcon } from "@ratel/design-system/entity";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import {
  IntentsNoReading,
  IntentsNothingToGroup,
  IntentsReadFailed,
} from "@/components/console/intents/IntentsStates";
import { AskIcon, InfoMark } from "@/components/console/intents/marks";
import type { ReadingRequest } from "@/components/console/intents/ReadNow";
import type { ExamplesLoad } from "@/components/console/intents/TopicExamples";
import type { IntentDetailLoad } from "@/components/console/intents/TopicPanel";
import {
  type LeadsLoad,
  type RowsLoad,
  TopicsTable,
} from "@/components/console/intents/TopicsTable";
import { CAPTURE_NEEDED } from "@/lib/views/intents/topics-explain";
import {
  type IntentsReading,
  intentsRoot,
  type TopicsSummary,
} from "@/lib/views/intents/topics-view";
import { tasksHref } from "@/lib/views/tasks/paths";

const n = (value: number) => value.toLocaleString("en-US");

/** The page's title, the same in its header, its loading state and the browser tab. */
export const INTENTS_TITLE = "All intents";

/** The page's crumb: Intents, whose landing page All intents is. */
export function intentsCrumbs(projectId: string) {
  return [{ label: "Intents", href: intentsRoot(projectId) }];
}

/** The reading's age, beside the window it covers. */
export function ReadingAge({ reading }: { reading: IntentsReading }) {
  if (reading.status !== "ready") return null;
  return (
    <span className="text-xs text-fg-subtle tabular-nums" title={reading.read.absolute}>
      Last 30 days, read {reading.read.relative.toLowerCase()}
    </span>
  );
}

const LEGEND_ITEM = "inline-flex items-center gap-1.5 whitespace-nowrap";

/**
 * The page's one line: how the nouns relate, as marks (DESIGN.md, "The
 * product's nouns"). Asks group into intents, and tasks handle them; with a
 * reading, each carries its number. A screen reader hears it as a sentence.
 */
export function IntentsLegend({
  projectId,
  counts,
}: {
  projectId: string;
  counts?: { asks: number; intents: number; tasks: number };
}) {
  const arrow = (
    <ArrowRight aria-hidden strokeWidth={1.5} className="size-3 shrink-0 text-fg-faint" />
  );
  const number = (value: number | undefined) =>
    value === undefined ? null : <span className="text-fg tabular-nums">{n(value)}</span>;
  return (
    <span
      data-intents-legend=""
      className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui text-fg-muted"
    >
      <span className={LEGEND_ITEM}>
        <AskIcon />
        {number(counts?.asks)}
        {counts ? " asks" : "Asks"}
      </span>
      {arrow}
      <span className="sr-only"> grouped into </span>
      <span className={LEGEND_ITEM}>
        <NounIcon noun="intent" />
        {number(counts?.intents)}
        {counts ? (counts.intents === 1 ? " intent" : " intents") : "Intents"}
      </span>
      {arrow}
      <span className="sr-only"> handled by </span>
      <Link
        href={tasksHref(projectId)}
        className={`${LEGEND_ITEM} rounded outline-none transition-colors duration-120 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus`}
      >
        <NounIcon noun="task" />
        {number(counts?.tasks)}
        {counts ? (counts.tasks === 1 ? " task" : " tasks") : "Tasks"}
      </Link>
    </span>
  );
}

/** Under the list, numbers only: what no intent holds, and what carried nothing to read. */
export function leftOut(summary: TopicsSummary, capped: boolean): string {
  const parts = [`${n(summary.unplaced)} of ${n(summary.turns)} asks fit no intent`];
  if (summary.noAsk > 0) parts.push(`${n(summary.noAsk)} carried no words to read`);
  if (summary.askedAgain > 0) parts.push(`${n(summary.askedAgain)} asked again`);
  if (capped) parts.push(`the newest ${n(summary.turns)} of the window`);
  return parts.join(" · ");
}

/**
 * Intents › All intents (DESIGN.md: "What do people want, and how does it
 * go?"). The header's one line is the legend (asks, intents, tasks); then
 * every intent as a row, its example ask under its name; a row opens its
 * panel. Before the first reading the page says what fills it and offers to
 * read now.
 */
export function TopicsView({
  projectId,
  reading,
  loadExamples,
  loadLeads,
  loadRows,
  loadDetail,
  requestReading,
}: {
  projectId: string;
  reading: IntentsReading;
  loadExamples: ExamplesLoad;
  loadLeads: LeadsLoad;
  loadRows: RowsLoad;
  loadDetail: IntentDetailLoad;
  requestReading: ReadingRequest;
}) {
  const ready = reading.status === "ready" && reading.view.topics.length > 0 ? reading : null;
  const summary = ready?.view.summary;
  return (
    <Page>
      <PageHeader
        crumbs={intentsCrumbs(projectId)}
        title={INTENTS_TITLE}
        description={
          <IntentsLegend
            projectId={projectId}
            counts={
              summary
                ? { asks: summary.turns, intents: summary.topics, tasks: summary.tasks }
                : undefined
            }
          />
        }
        actions={<ReadingAge reading={reading} />}
      />
      <PageBody wide>
        {reading.status === "failed" ? (
          <IntentsReadFailed />
        ) : reading.status === "none" ? (
          <IntentsNoReading inFlight={reading.inFlight} request={requestReading} />
        ) : !ready || !summary ? (
          <IntentsNothingToGroup turns={reading.turns} request={requestReading} />
        ) : (
          <section aria-label="Intents" className="flex flex-col gap-3">
            <TopicsTable
              topics={ready.view.topics}
              sentimentRead={summary.sentimentRead}
              loadExamples={loadExamples}
              loadLeads={loadLeads}
              loadRows={loadRows}
              loadDetail={loadDetail}
            />
            <div className="flex items-center gap-1.5 text-xs text-fg-subtle tabular-nums">
              <AskIcon className="size-3 text-fg-faint" />
              <p>{leftOut(summary, ready.view.capped)}</p>
              {summary.noAsk > 0 || !summary.sentimentMeasured ? (
                <InfoMark label="What needs people's own words">
                  <div className="flex flex-col gap-1.5">
                    <p className="font-medium text-fg">Needs people&apos;s own words</p>
                    <p>{CAPTURE_NEEDED}</p>
                  </div>
                </InfoMark>
              ) : null}
            </div>
          </section>
        )}
      </PageBody>
    </Page>
  );
}
