import { StatusDot } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { type Crumb, Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { GraphPicker } from "@/components/console/intents/GraphPicker";
import type {
  ChecklistStep,
  CurvePoint,
  GraphGrowth,
  RankingHeadline,
  ServingState,
} from "@/lib/views/adaptive-ranking/ranking";
import type { GraphChoice } from "@/lib/views/intents/map/labels";
import { RankingChart } from "./RankingChart";
import { RankingDetails, type RankingDetailsData } from "./RankingDetails";
import { SetupSteps } from "./SetupSteps";

export const RANKING_DESCRIPTION =
  "Puts the tool your agent needs first, using what people asked before.";

export type RankingGraphView = {
  choice: GraphChoice;
  serving: ServingState;
  headline: RankingHeadline;
  curve: CurvePoint[];
  growth: GraphGrowth;
  /** The steps still open for this graph, or null when it is served and current. */
  checklist: ChecklistStep[] | null;
  warnings: string[];
  details: RankingDetailsData;
};

const pct = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Adaptive ranking under Improvements (DESIGN.md: one question, "Does it
 * help?"). Whether the graph is served, one headline from the comparison,
 * the curve behind it, how far it has learned, and the steps still open. The
 * map of what it learned lives in Intents; the specialist's numbers sit
 * behind Details.
 */
export function RankingView({
  title,
  crumbs,
  choices,
  defaultKey,
  graph,
  intentsHref,
  emptyChecklist,
}: {
  title: string;
  crumbs: readonly Crumb[];
  choices: readonly GraphChoice[];
  defaultKey: string;
  graph: RankingGraphView | null;
  intentsHref: string;
  /** The whole checklist, for a project with no graph yet. */
  emptyChecklist: readonly ChecklistStep[];
}) {
  const mapLink = (
    <Link href={intentsHref} className={buttonVariants({ variant: "secondary" })}>
      See the intents
      <ArrowRight aria-hidden className="size-3.5" />
    </Link>
  );
  return (
    <Page>
      <PageHeader
        title={title}
        crumbs={crumbs}
        description={RANKING_DESCRIPTION}
        actions={
          graph ? (
            <>
              <GraphPicker
                choices={choices}
                value={graph.choice.graphKey}
                defaultKey={defaultKey}
              />
              {mapLink}
            </>
          ) : null
        }
      />
      <PageBody>
        {graph ? <GraphReading graph={graph} /> : <RankingEmpty steps={emptyChecklist} />}
      </PageBody>
    </Page>
  );
}

function GraphReading({ graph }: { graph: RankingGraphView }) {
  const { headline, serving, growth } = graph;
  return (
    <>
      {graph.warnings.length > 0 ? (
        <Callout tone="warning" title="Worth a look">
          {graph.warnings.length === 1 ? (
            graph.warnings[0]
          ) : (
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {graph.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </Callout>
      ) : null}

      <section
        aria-labelledby="ranking-answer"
        data-ranking-state={headline.state}
        data-served={serving.served}
        className="flex flex-col gap-6"
      >
        <div className="flex flex-col gap-2">
          <StatusDot tone={serving.tone} label={serving.label} />
          <h2 id="ranking-answer" className="text-xl font-semibold tracking-tight text-fg">
            {headline.title}
          </h2>
          <p className="max-w-3xl text-sm text-fg-muted">
            {headline.detail} {serving.sentence}
          </p>
          {headline.notes.length > 0 ? (
            <ul
              data-ranking-notes=""
              className="flex max-w-3xl flex-col gap-1 text-xs text-fg-subtle"
            >
              {headline.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </div>
        {headline.withGraph !== null && graph.curve.length > 1 ? (
          <RankingChart points={graph.curve} estimated={headline.estimated} />
        ) : null}
      </section>

      <Section title="How far it has learned">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 rounded-lg border border-line p-4">
            <dt className="text-xs font-medium text-fg-subtle">Learned</dt>
            <dd className="flex items-center gap-3">
              <span className="text-2xl font-semibold tracking-tight text-fg tabular-nums">
                {pct(growth.learned)}
              </span>
              <DotMeter
                value={growth.learned}
                tone="neutral"
                label={`Learned ${pct(growth.learned)}`}
              />
            </dd>
            <dd className="text-xs text-fg-subtle">
              Of ask groups seen often enough to count in full.
            </dd>
          </div>
          <div className="flex flex-col gap-1.5 rounded-lg border border-line p-4">
            <dt className="text-xs font-medium text-fg-subtle">Room used</dt>
            <dd className="flex items-center gap-3">
              <span className="text-2xl font-semibold tracking-tight text-fg tabular-nums">
                {pct(growth.used)}
              </span>
              <DotMeter
                value={growth.used}
                tone="neutral"
                label={`Room used ${pct(growth.used)}`}
              />
            </dd>
            <dd className="text-xs text-fg-subtle tabular-nums">{growth.usedLabel}</dd>
          </div>
        </dl>
      </Section>

      {graph.checklist ? (
        <Section title={serving.served ? "Keep it current" : "Start serving it"}>
          <SetupSteps
            steps={graph.checklist}
            label={serving.served ? "Keep it current" : "Start serving it"}
          />
        </Section>
      ) : null}

      <RankingDetails data={graph.details} />
    </>
  );
}

/** No graph yet: what adaptive ranking needs, as a visible, numbered checklist. */
export function RankingEmpty({ steps }: { steps: readonly ChecklistStep[] }) {
  return (
    <section
      aria-label="Set up adaptive ranking"
      data-ranking-empty=""
      className="flex flex-col gap-6 rounded-lg border border-line p-6"
    >
      <EmptyState
        emblem
        title="No ranking to show yet"
        description="Adaptive ranking learns which tool answers which ask from your agent's traffic, then puts that tool first. These steps get it there."
        className="py-4"
      />
      <SetupSteps steps={steps} label="Set up adaptive ranking" />
    </section>
  );
}
