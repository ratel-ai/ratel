import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import Link from "next/link";
import {
  plural,
  READ_BY_MEANING,
  SENTIMENT_DESCRIPTION,
} from "@/components/console/sentiment/copy";
import { DailyTrend } from "@/components/console/sentiment/DailyTrend";
import { DissatisfactionPareto } from "@/components/console/sentiment/DissatisfactionPareto";
import { RootCauses } from "@/components/console/sentiment/RootCauses";
import { SatisfactionBreakdown } from "@/components/console/sentiment/SatisfactionBreakdown";
import { SatisfactionByStatus } from "@/components/console/sentiment/SatisfactionByStatus";
import { SatisfactionScore } from "@/components/console/sentiment/SatisfactionScore";
import { SentimentFilters } from "@/components/console/sentiment/SentimentFilters";
import { LinkSwitch, type LinkSwitchOption } from "@/components/console/settings/LinkSwitch";
import type { PanelTurn } from "@/components/console/turn-panel/useTurnPanel";
import { projectRoot } from "@/lib/console/navigation";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { agentHealthHref, windowPhrase } from "@/lib/readings/trace-signals/view";
import { CAUSE_PEEK } from "@/lib/views/traces/sentiment/cause-peek";
import type { Overview } from "@/lib/views/traces/sentiment/overview";
import { type SentimentLinks, sentimentLinks } from "@/lib/views/traces/sentiment/page-links";
import type { SentimentPageModel } from "@/lib/views/traces/sentiment/page-model";
import {
  type RootCauseHost,
  rootCausesHref,
  sentimentHref,
} from "@/lib/views/traces/sentiment/page-paths";

/**
 * Sentiment analysis (Traces): how people took the agent's work, and
 * only that. Top to bottom: one notice on what could be read (the trace
 * alone, the agent's replies, or people's messages too), the filters, the
 * satisfaction score with the turns it stands on, satisfaction in each task
 * status, what drives dissatisfaction, the intents people were
 * most and least satisfied with, and satisfaction day by day. Whether tasks
 * got done, and why not, is Agent health's Task completion and Root cause
 * analysis.
 */
export function SentimentView({
  model,
  windows,
  now,
  turn = null,
  rootCauses = null,
}: {
  model: SentimentPageModel;
  /** The time windows the plan allows, as links. */
  windows: readonly LinkSwitchOption[];
  /** The request's time, so relative times match between server and client. */
  now: string;
  /** The turn the address opens in the Panel, with what Traces shows of it. */
  turn?: PanelTurn | null;
  /** The root causes the address opens over the page; null while closed. */
  rootCauses?: SentimentPageModel | null;
}) {
  const links = sentimentLinks(model);
  return (
    <RootCauses
      projectId={model.projectId}
      windowDays={model.windowDays}
      model={rootCauses}
      host={hostOf(model)}
      otherParam={CAUSE_PEEK}
      now={now}
      turn={turn}
    >
      <Page>
        <PageHeader
          title="Sentiment analysis"
          crumbs={[{ label: "Traces", href: `${projectRoot(model.projectId)}/traces` }]}
          description={SENTIMENT_DESCRIPTION}
          actions={windows.length > 1 ? <LinkSwitch label="Time window" options={windows} /> : null}
        />
        <PageBody wide>
          <Body model={model} links={links} now={now} turn={turn} />
        </PageBody>
      </Page>
    </RootCauses>
  );
}

/** This page with its window and filters, as the host of the root causes panel. */
function hostOf(model: SentimentPageModel): RootCauseHost {
  const { filters, sort, thin } = model.query;
  const [path = "", query = ""] = sentimentHref(model.projectId, {
    days: model.windowDays,
    filters,
    sort,
    thin,
  }).split("?");
  return { path, query };
}

function Body({
  model,
  links,
  now,
  turn,
}: {
  model: SentimentPageModel;
  links: SentimentLinks;
  now: string;
  turn: PanelTurn | null;
}) {
  const span = windowPhrase(model.windowDays);
  if (model.state === "unavailable") {
    return (
      <Callout tone="danger" title="Couldn't load sentiment analysis">
        Try again in a moment. The rest of Agent health still works.
      </Callout>
    );
  }
  if (model.state === "empty") {
    return (
      <EmptyState
        emblem
        title={`No sessions read ${span}`}
        description="Satisfaction shows up after the next reading of your agent's runs. Pick a longer window, or check that your agent is sending traces."
        action={
          <Link
            href={agentHealthHref(model.projectId)}
            className={buttonVariants({ variant: "secondary" })}
          >
            Open Agent health
          </Link>
        }
      />
    );
  }
  const read = model.text.state === "capped" || model.text.state === "read";
  return (
    <>
      <TextNotice model={model} />
      {/* Filters narrow every section below them, so they sit first. */}
      <SentimentFilters filters={links.filters} clearHref={links.clearHref} />
      <StatRow stats={headline(model.overview, read)} />
      <SatisfactionByStatus
        overview={model.overview}
        hrefOf={(filter) =>
          filter === "completed" ||
          !model.overview.statuses.some((status) => status.filter === filter && status.tasks > 0)
            ? null
            : rootCausesHref(model.projectId, {
                filters: { ...model.query.filters, task: filter, reason: null },
                host: hostOf(model),
              })
        }
      />
      <DissatisfactionPareto
        projectId={model.projectId}
        dissatisfaction={model.overview.dissatisfaction}
        now={now}
        turn={turn}
      />
      <SatisfactionBreakdown links={links} />
      <DailyTrend days={model.overview.daily} />
      <p className="text-xs text-fg-subtle">
        Rule: {READ_BY_MEANING.rule} Model: {READ_BY_MEANING.model}
      </p>
    </>
  );
}

/** Three numbers: the satisfaction score (with its meter), and the satisfied and unsatisfied turns it stands on. */
function headline(overview: Overview, read: boolean): StatProps[] {
  const { satisfaction } = overview;
  const allInferred = satisfaction.answers > 0 && satisfaction.inferred === satisfaction.answers;
  const inferredNote =
    satisfaction.inferred === 0
      ? ""
      : allInferred
        ? ", read from the agent's replies"
        : `, ${formatCount(satisfaction.inferred)} read from the agent's replies`;
  return [
    {
      label: allInferred ? "User satisfaction, inferred" : "User satisfaction",
      value:
        satisfaction.score === null ? (
          "None"
        ) : (
          <SatisfactionScore score={satisfaction.score} size="lg" />
        ),
      hint:
        satisfaction.score === null
          ? read
            ? "Nobody reacted to a reply"
            : "Needs user messages, or replies that show it"
          : `Turns people did not push back on, of ${plural(satisfaction.answers, "turn")} they reacted to${inferredNote}`,
    },
    {
      label: "Turns without a complaint",
      value: formatCount(satisfaction.satisfied),
      hint: "People thanked the agent or moved on",
    },
    {
      label: "Unsatisfied turns",
      value: formatCount(satisfaction.answers - satisfaction.satisfied),
      hint: "People corrected, repeated, or were unhappy",
    },
  ];
}

/** The one notice: what the page could read. Nothing when people's messages were all read. */
function TextNotice({ model }: { model: SentimentPageModel }) {
  const { text } = model;
  const setup = (
    <Link
      href={agentHealthHref(model.projectId)}
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      See how to send them
    </Link>
  );
  switch (text.state) {
    case "no_text":
      return text.inferred ? (
        <Callout title="Read from the trace and the agent's replies" action={setup}>
          {`This project sends no user messages. Besides rules on the trace, how people took ${plural(text.inferred.turns, "turn")} is inferred from the agent's replies, and labelled so. Sending user messages reads their own words instead.`}
        </Callout>
      ) : (
        <Callout title="Read from the trace alone" action={setup}>
          This project sends no user messages, so every number here comes from rules on the trace:
          failed calls, what followed them and requests left open. Sending user messages adds
          whether people were satisfied, how they reacted, and the turns where they gave up or asked
          for a human.
        </Callout>
      );
    case "model_off":
      return (
        <Callout tone="warning" title="User messages are not being read">
          {plural(text.textTurns, "turn")} sent a message, but the model that reads them is off for
          this workspace. Until it is on, every number here comes from rules on the trace.
        </Callout>
      );
    case "capped":
      return (
        <Callout title="Part of the messages were read">
          A model read {formatCount(text.answeredTurns)} of {plural(text.textTurns, "turn")} with a
          message. The rest are read from the trace alone, by rules.
        </Callout>
      );
    case "read":
      return null;
  }
}
