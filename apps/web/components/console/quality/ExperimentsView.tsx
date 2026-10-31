import { buttonVariants } from "@ratel/design-system/button-variants";
import { Section } from "@ratel/design-system/section";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { ArrowRight, CircleCheck } from "lucide-react";
import Link from "next/link";
import type { ExperimentsData } from "@/lib/views/quality/load-experiments";
import { percent, plural } from "@/lib/views/quality/model";
import { DisagreementsList } from "./DisagreementsList";
import { ExperimentsTable } from "./ExperimentsTable";
import { LoadFailed } from "./states";

/**
 * The Experiments tab: every experiment in the window with its three numbers,
 * then the open one: how often both variants agree, and the searches where
 * they did not. Latency and the comparison funnel stay on the detail page.
 */
export function ExperimentsView({
  projectId,
  data,
  rowHrefs,
  windowPhrase,
  wider,
  now,
}: {
  projectId: string;
  /** Null when the read failed. */
  data: ExperimentsData | null;
  /** Where each experiment row goes. */
  rowHrefs: Record<string, string>;
  windowPhrase: string;
  wider: { href: string; label: string } | null;
  now: Date;
}) {
  if (data === null) return <LoadFailed what="experiments" />;
  if (data.rows.length === 0) {
    return (
      <div className="rounded-lg border border-line" data-tab="experiments">
        <EmptyState
          emblem
          title={`No experiments in ${windowPhrase}`}
          description="An experiment ranks each search a second way beside the one your agent sees, so the two can be compared."
          action={
            wider ? (
              <Link
                href={wider.href}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                {wider.label}
              </Link>
            ) : null
          }
        />
      </div>
    );
  }
  const iso = now.toISOString();
  return (
    <div className="flex flex-col gap-8" data-tab="experiments">
      <ExperimentsTable
        rows={data.rows}
        hrefs={rowHrefs}
        selected={data.selected?.row.name ?? null}
        now={iso}
      />
      {data.selected ? (
        <OpenExperiment projectId={projectId} selected={data.selected} now={iso} />
      ) : null}
    </div>
  );
}

function OpenExperiment({
  projectId,
  selected,
  now,
}: {
  projectId: string;
  selected: NonNullable<ExperimentsData["selected"]>;
  now: string;
}) {
  const { row, kpis, disagreements, detailHref } = selected;
  const detail = (
    <Link
      href={detailHref}
      className="inline-flex items-center gap-1 rounded-md text-ui text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
    >
      Latency and reliability
      <ArrowRight aria-hidden className="size-3.5" />
    </Link>
  );
  if (row.kind !== "ranking" || !kpis) {
    return (
      <Callout title={`${row.name} did not compare rankings`} action={detail}>
        Its runs are on the detail page.
      </Callout>
    );
  }
  const variants =
    kpis.current && kpis.comparison ? (
      <>
        Current variant <span className="font-mono text-xs text-fg">{kpis.current}</span>,
        comparison <span className="font-mono text-xs text-fg">{kpis.comparison}</span>
      </>
    ) : undefined;
  return (
    <>
      <Section title={row.name} description={variants} actions={detail}>
        <StatRow
          stats={[
            {
              label: "Agreement on first pick",
              value: percent(kpis.firstPick),
              hint: `Over ${plural(kpis.comparisons, "search", "searches")} compared`,
            },
            {
              label: "Same order",
              value: percent(kpis.sameOrder),
              hint: "The whole list, in the same order",
            },
            {
              label: "Coverage",
              value: percent(kpis.coverage),
              hint: "Searches compared, of those that could be",
            },
          ]}
        />
      </Section>
      <Section
        title={`Where they disagreed (${kpis.disagreements.toLocaleString("en-US")})`}
        description={
          kpis.disagreements > disagreements.length && disagreements.length > 0
            ? `The ${disagreements.length} most recent.`
            : undefined
        }
      >
        {disagreements.length === 0 ? (
          <div className="rounded-lg border border-line">
            <EmptyState
              icon={CircleCheck}
              title="The variants agreed on every search"
              description="Both returned the same tools in the same order."
            />
          </div>
        ) : (
          <DisagreementsList projectId={projectId} rows={disagreements} now={now} />
        )}
      </Section>
    </>
  );
}
