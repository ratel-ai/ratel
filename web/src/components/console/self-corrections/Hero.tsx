import { cn } from "@ratel/design-system/cn";
import { DotSpark } from "@ratel/design-system/dot-matrix";
import { PeekLink } from "@ratel/design-system/panel";
import { ArrowDownRight, ArrowRight, ArrowUpRight, SlidersHorizontal } from "lucide-react";
import { KIND_ICONS, KIND_SHORT } from "@/components/console/self-corrections/kind-marks";
import { DETAILS_PEEK } from "@/components/console/self-corrections/peeks";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import type {
  SelfCorrectionsPageModel,
  StatView,
} from "@/lib/views/health/self-corrections/page-model";

/**
 * The page's answer at a glance: self-corrections per 100 turns with its
 * change and its trend, three small figures (recovered, asked again, gave
 * up), and the kinds as a strip of marks with their counts. What each number
 * counts, the kinds' meanings and the rest sit in the Details panel
 * (`?peek=details`), one click away.
 */

export function Hero({ model }: { model: SelfCorrectionsPageModel }) {
  const [rate, recovered, asked, gaveUp] = model.stats;
  const kinds = model.byKind.filter((row) => row.measured && row.events > 0);
  const unmeasured = model.byKind.some((row) => !row.measured);
  return (
    <section
      aria-label="Self-corrections at a glance"
      className="flex flex-col gap-5 rounded-lg border border-line bg-raised p-5"
      data-corrections-hero=""
    >
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        {rate ? <Headline rate={rate} trend={model.trend} /> : null}
        <dl className="grid grid-cols-3 gap-x-8">
          {[recovered, asked, gaveUp].map((stat) =>
            stat ? (
              <div key={stat.label} className="flex flex-col gap-1" data-hero-figure={stat.label}>
                <dt className="text-xs font-medium whitespace-nowrap text-fg-subtle">
                  {shortLabel(stat.label)}
                </dt>
                <dd className="text-lg font-semibold text-fg tabular-nums">{stat.value}</dd>
              </div>
            ) : null,
          )}
        </dl>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-line pt-4">
        <ul
          aria-label="By kind"
          className="flex flex-wrap items-center gap-1.5"
          data-kind-strip={kinds.length}
        >
          {kinds.map((row) => {
            const Icon = KIND_ICONS[row.kind];
            return (
              <li
                key={row.kind}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-app px-2 text-xs text-fg-muted"
                data-kind={row.kind}
              >
                <Icon aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0 text-fg-subtle" />
                {KIND_SHORT[row.kind]}
                <span className="font-medium text-fg tabular-nums">{formatCount(row.events)}</span>
              </li>
            );
          })}
          {unmeasured ? (
            <li className="text-xs text-fg-subtle">Phrases need content capture</li>
          ) : null}
        </ul>
        <PeekLink
          peek={DETAILS_PEEK}
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-ui font-medium text-fg-muted outline-none transition-colors duration-120 hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          <SlidersHorizontal aria-hidden strokeWidth={1.5} className="size-3.5" />
          Details
        </PeekLink>
      </div>
    </section>
  );
}

/** "Asked again next turn" is long for a small figure; the Panel keeps the full words. */
function shortLabel(label: string): string {
  return label === "Asked again next turn" ? "Asked again" : label;
}

function Headline({ rate, trend }: { rate: StatView; trend: SelfCorrectionsPageModel["trend"] }) {
  return (
    <div className="flex items-end gap-6" data-hero-rate="">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-fg-subtle">{rate.label}</p>
        <p className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tracking-tight text-fg tabular-nums">
            {rate.value}
          </span>
          {rate.delta ? <Delta delta={rate.delta} /> : null}
        </p>
      </div>
      {trend ? (
        <DotSpark values={trend.values} rows={8} label={trend.label} className="mb-1.5" />
      ) : null}
    </div>
  );
}

function Delta({ delta }: { delta: NonNullable<StatView["delta"]> }) {
  const Icon =
    delta.direction === "up"
      ? ArrowUpRight
      : delta.direction === "down"
        ? ArrowDownRight
        : ArrowRight;
  const tone =
    delta.good === null || delta.direction === "flat"
      ? "text-fg-subtle"
      : delta.good
        ? "text-success"
        : "text-danger";
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium tabular-nums", tone)}>
      <Icon aria-hidden className="size-3" />
      {delta.value}
      <span className="sr-only"> {delta.label}</span>
    </span>
  );
}
