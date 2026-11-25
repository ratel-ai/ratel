import { buttonVariants } from "@ratel/design-system/button-variants";
import { Section } from "@ratel/design-system/section";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { ChartBarBig, CircleCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import {
  money,
  percent,
  plural,
  READ_BY_MEANING,
  tokensLabel,
} from "@/components/console/sentiment/copy";
import { ReasonBars } from "@/components/console/sentiment/ReasonBars";
import { ReasonTable } from "@/components/console/sentiment/ReasonTable";
import { RootCauseFilters } from "@/components/console/sentiment/RootCauseFilters";
import { RootCausesHost } from "@/components/console/sentiment/RootCausesHost";
import type { PanelTurn } from "@/components/console/turn-panel/useTurnPanel";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { type WindowDays, windowPhrase } from "@/lib/readings/trace-signals/view";
import { formatDuration } from "@/lib/synthesis/traces/v2/format";
import { type SentimentLinks, sentimentLinks } from "@/lib/views/traces/sentiment/page-links";
import type { SentimentPageModel } from "@/lib/views/traces/sentiment/page-model";
import type { RootCauseHost } from "@/lib/views/traces/sentiment/page-paths";
import { MAX_PAGE_TURNS } from "@/lib/views/traces/sentiment/page-queries";

/**
 * Root cause analysis: why tasks were not completed, and what got in the way
 * of the ones completed after friction. It is a panel over its host page;
 * this wraps the page, and reads nothing until the address opens it.
 */
export function RootCauses({
  projectId,
  windowDays,
  model,
  host,
  otherParam,
  now,
  turn,
  children,
}: {
  projectId: string;
  windowDays: WindowDays;
  /** Null while the panel is closed. */
  model: SentimentPageModel | null;
  host: RootCauseHost;
  /** The parameter of the host page's own panel. */
  otherParam: string;
  /** The request's time, so relative times match between server and client. */
  now: string;
  turn: PanelTurn | null;
  children: ReactNode;
}) {
  const links = model ? sentimentLinks(model, "root-causes", host) : null;
  return (
    <RootCausesHost
      content={model && links ? <Body model={model} links={links} now={now} /> : null}
      groups={links?.reasonGroups ?? []}
      subtitle={`Why tasks were not completed, or only after friction, ${windowPhrase(windowDays)}`}
      now={now}
      turn={turn}
      otherParam={otherParam}
      key={projectId}
    >
      {children}
    </RootCausesHost>
  );
}

/**
 * Top to bottom: four numbers (not completed, completed after friction, the
 * cost of failure and the cost of friction), the reasons as bars to pick
 * from, and the root causes under each reason in one table, ordered by tasks,
 * cost or time, each opening in the same panel.
 */
function Body({
  model,
  links,
  now,
}: {
  model: SentimentPageModel;
  links: SentimentLinks;
  now: string;
}) {
  const span = windowPhrase(model.windowDays);
  if (model.state === "unavailable") {
    return (
      <Callout tone="danger" title="Couldn't load root cause analysis">
        Try again in a moment. The rest of Agent health still works.
      </Callout>
    );
  }
  const { overview } = model;
  if (model.state === "empty" || overview.tasks === 0) {
    return (
      <EmptyState
        emblem
        title={`No tasks read ${span}`}
        description="Tasks show up after the next reading of your agent's runs. Pick a longer window, or check that your agent is sending traces."
      />
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <StatRow stats={headline(model, links)} className="lg:grid-cols-2" />
      <Section title={<NounTitle icon={ChartBarBig}>Reasons</NounTitle>}>
        {overview.failure.tasks + overview.friction.tasks === 0 ? (
          <EmptyState
            icon={CircleCheck}
            title={`Every task went smoothly ${span}`}
            description="No task was left undone, and none needed a retry, a correction or a repeat."
          />
        ) : (
          <ReasonBars statuses={links.reasonStatuses} reasons={links.reasonChoices} />
        )}
      </Section>
      {overview.failure.tasks + overview.friction.tasks > 0 ? (
        <Section title={<NounTitle icon={TriangleAlert}>Root causes by reason</NounTitle>}>
          {/* The filters sit on the table they narrow: a reason picked above shows here, removable. */}
          <RootCauseFilters
            filters={links.filters}
            options={links.filterOptions}
            clearHref={links.clearHref}
          />
          <ReasonTable
            groups={links.reasonGroups}
            sort={model.query.sort}
            sortHrefs={links.sortHrefs}
            costKnown={overview.costKnown}
            now={now}
            empty={<NoMatch links={links} span={span} />}
          />
          <Footnotes model={model} />
        </Section>
      ) : null}
    </div>
  );
}

/**
 * Four numbers: the two statuses that need explaining (each narrows the
 * page), what failure cost (tasks not completed, whole) and what friction
 * cost (the extra turns and retried calls of tasks completed after
 * friction), in tokens, with the cost and time under them. Without token
 * counts sent, time stands in.
 */
function headline(model: SentimentPageModel, links: SentimentLinks): StatProps[] {
  const { overview } = model;
  const { failure, friction } = overview;
  // In tokens; without token counts sent, the time it took stands in.
  const spent = (part: { tokens: number | null; timeMs: number }) =>
    part.tokens === null ? formatDuration(part.timeMs) : tokensLabel(part.tokens);
  const extras = (part: { tokens: number | null; costUsd: number | null; timeMs: number }) =>
    [
      part.costUsd === null ? null : money(part.costUsd),
      part.tokens === null ? null : formatDuration(part.timeMs),
    ]
      .filter(Boolean)
      .join(" · ");
  const status = (filter: "not_completed" | "completed_after_friction"): StatProps => {
    const entry = links.statuses.find((item) => item.filter === filter)!;
    return {
      label: entry.label,
      value: formatCount(entry.tasks),
      hint: `${percent(entry.share)} of ${plural(overview.tasks, "task")}`,
      href: entry.href,
    };
  };
  return [
    status("not_completed"),
    status("completed_after_friction"),
    {
      label: "Cost of failure",
      value: spent(failure),
      hint: [`${plural(failure.tasks, "task")} not completed, whole`, extras(failure)]
        .filter(Boolean)
        .join(" · "),
    },
    {
      label: "Cost of friction",
      value: spent(friction),
      hint: [
        `${plural(friction.extraTurns, "extra turn")}, ${plural(friction.retriedCalls, "retried call")}`,
        extras(friction),
      ]
        .filter(Boolean)
        .join(" · "),
    },
  ];
}

function NoMatch({ links, span }: { links: SentimentLinks; span: string }) {
  return (
    <EmptyState
      emblem
      title="No root causes match these filters"
      description={`No task ${span} with these filters was left undone or completed after friction.`}
      action={
        <Link
          href={links.clearHref}
          scroll={false}
          className={buttonVariants({ variant: "secondary" })}
        >
          Clear filters
        </Link>
      }
    />
  );
}

/** Under the table: what cost needs, the cap, and how the numbers were read. */
function Footnotes({ model }: { model: SentimentPageModel }) {
  return (
    <div className="flex flex-col gap-1 text-xs text-fg-subtle" data-root-cause-footnotes="">
      {!model.overview.costKnown ? (
        <p>
          Cost shows when your agent sends its model calls with token usage (OpenTelemetry). Time is
          how long the tasks took, end to end.
        </p>
      ) : null}
      {model.capped ? (
        <p>
          This window held more than the newest {formatCount(MAX_PAGE_TURNS)} turns that were read.
          Pick a shorter window for exact counts.
        </p>
      ) : null}
      <p>
        Rule: {READ_BY_MEANING.rule} Model: {READ_BY_MEANING.model}
      </p>
    </div>
  );
}
