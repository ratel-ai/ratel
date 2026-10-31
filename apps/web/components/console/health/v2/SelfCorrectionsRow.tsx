import { buttonVariants } from "@ratel/design-system/button-variants";
import { DotMeter, DotSpark } from "@ratel/design-system/dot-matrix";
import { ToolPin } from "@ratel/design-system/entity";
import { Section } from "@ratel/design-system/section";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { ArrowRight, CircleCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { windowPhrase } from "@/lib/readings/trace-signals/view";
import type { SelfCorrectionsCardModel } from "@/lib/views/health/self-corrections/card";

/**
 * Self-corrections on the Summary, as its own row: the headline only, the
 * page explains (DESIGN.md, Principle 2). The rate per 100 turns with its
 * change and trend, the share of failed calls the agent got past, the tool
 * it corrects itself after most (a pin that narrows the page to it), the
 * phrase it says most, and the way to the page. Server-safe: no client state.
 */

export const CORRECTIONS_TITLE = "Self-corrections";

const NOTE: Readonly<Record<Exclude<SelfCorrectionsCardModel["state"], "ready">, string>> = {
  unavailable: "Couldn't load self-corrections. Try again in a moment.",
  not_read: "They show up after the next reading of your agent's runs.",
  mixed_runs: "Needs turn ids: calls from different people are mixed in one run.",
  no_turns: "No runs in this window.",
};

export function SelfCorrectionsRow({ model }: { model: SelfCorrectionsCardModel }) {
  return (
    <Section
      title={<NounTitle noun="selfCorrection">{CORRECTIONS_TITLE}</NounTitle>}
      actions={
        <Link
          href={model.href}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          data-corrections-open=""
        >
          See self-corrections
          <ArrowRight aria-hidden />
        </Link>
      }
    >
      <div
        data-health-corrections={
          model.state === "ready" && model.events === 0 ? "none" : model.state
        }
      >
        {model.state !== "ready" ? (
          <Quiet>{NOTE[model.state]}</Quiet>
        ) : model.events === 0 ? (
          <Quiet>
            <CircleCheck aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-success" />
            None {windowPhrase(model.windowDays)}: the agent did not retry, switch tools, give up or
            apologize.
          </Quiet>
        ) : (
          <StatRow stats={stats(model)} />
        )}
      </div>
    </Section>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-2 text-ui text-fg-muted">{children}</p>;
}

const times = (n: number) => `${formatCount(n)} ${n === 1 ? "time" : "times"}`;

/** The row's four numbers, pins and words first; each says what it needs when it has nothing. */
export function stats(model: SelfCorrectionsCardModel): StatProps[] {
  const { rate, trend, recovered, recoveredShare, topTool, topPhrase } = model;
  return [
    {
      label: "Per 100 turns",
      value: rate.value,
      ...(rate.delta ? { delta: rate.delta } : {}),
      ...(trend ? { trend: <DotSpark values={trend.values} label={trend.label} /> } : {}),
      href: model.href,
    },
    {
      label: "Recovered",
      value: recovered?.value ?? "–",
      ...(recoveredShare !== null
        ? {
            trend: (
              <DotMeter
                value={recoveredShare}
                cells={12}
                tone="neutral"
                label={`${recovered?.value ?? ""} of failed calls recovered`}
              />
            ),
          }
        : { hint: "No tool call failed" }),
    },
    {
      label: "Most after",
      value: topTool ? (
        <ToolPin
          name={topTool.name}
          kind={topTool.entryKind}
          href={topTool.href}
          className="font-normal"
        />
      ) : (
        "–"
      ),
      hint: topTool ? times(topTool.events) : "No tool call before them",
    },
    {
      label: "Top phrase",
      value: topPhrase ? <span className="text-base font-medium">“{topPhrase.phrase}”</span> : "–",
      hint: topPhrase
        ? times(topPhrase.events)
        : model.phrasesCaptured
          ? "Said nothing to take back"
          : "Needs content capture",
    },
  ];
}
