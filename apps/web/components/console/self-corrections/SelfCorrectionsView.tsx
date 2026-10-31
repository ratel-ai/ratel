import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { CircleCheck } from "lucide-react";
import Link from "next/link";
import { Change } from "@/components/console/self-corrections/Change";
import { SELF_CORRECTIONS_DESCRIPTION } from "@/components/console/self-corrections/copy";
import { DetailsPanel } from "@/components/console/self-corrections/DetailsPanel";
import { Filters } from "@/components/console/self-corrections/Filters";
import type { FixAction } from "@/components/console/self-corrections/fix-actions";
import { Hero } from "@/components/console/self-corrections/Hero";
import { Said } from "@/components/console/self-corrections/Said";
import { Where } from "@/components/console/self-corrections/Where";
import { LinkSwitch, type LinkSwitchOption } from "@/components/console/settings/LinkSwitch";
import { agentHealthHref, windowPhrase } from "@/lib/readings/trace-signals/view";
import type { SelfCorrectionsPageModel } from "@/lib/views/health/self-corrections/page-model";

/**
 * Self-corrections (Agent health): how often the agent goes back on itself,
 * where, what it said, and what to change, for a calm read top to bottom:
 * the hero (per 100 turns with its trend and three small figures), where it
 * happens (tools, tasks and intents as pins), what the agent said (top
 * phrases and highlighted examples), and what to change (each fix's one
 * action; description updates go to Quality › Descriptions). The sentences
 * behind the numbers live in Panels.
 */

export { SELF_CORRECTIONS_DESCRIPTION } from "@/components/console/self-corrections/copy";

export function SelfCorrectionsView({
  model,
  windows,
  clearHref,
  now,
  actions = {},
}: {
  model: SelfCorrectionsPageModel;
  /** The time windows the plan allows, as links. */
  windows: readonly LinkSwitchOption[];
  /** This page without filters, on the same window. */
  clearHref: string;
  /** The request's time, so relative times match between server and client. */
  now: string;
  /** What each fix's button does, by issue id; a fix without one opens Fixes on its subject. */
  actions?: Readonly<Record<string, FixAction>>;
}) {
  return (
    <Page>
      <PageHeader
        title="Self-corrections"
        crumbs={[{ label: "Agent health", href: agentHealthHref(model.projectId) }]}
        description={SELF_CORRECTIONS_DESCRIPTION}
        actions={windows.length > 1 ? <LinkSwitch label="Time window" options={windows} /> : null}
      />
      <PageBody>
        <Filters filters={model.filters} clearHref={clearHref} />
        <Body model={model} clearHref={clearHref} now={now} actions={actions} />
      </PageBody>
    </Page>
  );
}

function Body({
  model,
  clearHref,
  now,
  actions,
}: {
  model: SelfCorrectionsPageModel;
  clearHref: string;
  now: string;
  actions: Readonly<Record<string, FixAction>>;
}) {
  const health = agentHealthHref(model.projectId);
  const span = windowPhrase(model.windowDays);
  switch (model.state) {
    case "unavailable":
      return (
        <Callout tone="danger" title="Couldn't load self-corrections">
          Try again in a moment. The rest of Agent health still works.
        </Callout>
      );
    case "not_read":
      return (
        <EmptyState
          emblem
          title="No reading yet"
          description="Self-corrections show up after the next reading of your agent's runs, usually within the hour."
          action={
            <Link href={health} className={buttonVariants({ variant: "secondary" })}>
              Open Agent health
            </Link>
          }
        />
      );
    case "mixed_runs":
      return (
        <Callout
          tone="warning"
          title="Needs turn ids"
          action={
            <Link href={health} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              See how to send them
            </Link>
          }
        >
          Calls from different people are mixed in one run, so a retry can&apos;t be told from
          someone else&apos;s next call. Send a turn id with each request.
        </Callout>
      );
    case "no_turns":
      return model.filters.length > 0 ? (
        <EmptyState
          emblem
          title="No runs match these filters"
          description={`Nothing ran ${span} with these filters.`}
          action={
            <Link href={clearHref} className={buttonVariants({ variant: "secondary" })}>
              Clear filters
            </Link>
          }
        />
      ) : (
        <EmptyState
          emblem
          title={`No runs ${span}`}
          description="Pick a longer window, or check that your agent is sending traces."
        />
      );
    case "ready":
      return <Ready model={model} now={now} actions={actions} />;
  }
}

function Ready({
  model,
  now,
  actions,
}: {
  model: SelfCorrectionsPageModel;
  now: string;
  actions: Readonly<Record<string, FixAction>>;
}) {
  if (model.events === 0) {
    return (
      <EmptyState
        icon={CircleCheck}
        title={`No self-corrections ${windowPhrase(model.windowDays)}`}
        description="The agent did not retry, switch tools, give up or apologize."
      />
    );
  }
  return (
    <>
      <Hero model={model} />
      <Where model={model} />
      <Said model={model} now={now} />
      <Change fixes={model.fixes} actions={actions} />
      <DetailsPanel
        stats={model.stats}
        kinds={model.byKind}
        computedAt={model.computedAt}
        now={now}
      />
    </>
  );
}
