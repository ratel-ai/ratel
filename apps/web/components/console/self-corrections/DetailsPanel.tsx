"use client";

import { cn } from "@ratel/design-system/cn";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { KIND_ICONS } from "@/components/console/self-corrections/kind-marks";
import { DETAILS_PEEK } from "@/components/console/self-corrections/peeks";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { PLAIN_KIND_MEANINGS } from "@/lib/readings/trace-signals/self-corrections/kinds";
import { formatRelativeTime, formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import type { KindRow, StatView } from "@/lib/views/health/self-corrections/page-model";

/**
 * The page's details, one click from the hero (`?peek=details`): what each
 * number counts, every kind with what it means and how often it happened,
 * and when the reading was taken. The face keeps the numbers; the sentences
 * live here.
 */
export function DetailsPanel({
  stats,
  kinds,
  computedAt,
  now,
}: {
  stats: readonly StatView[];
  kinds: readonly KindRow[];
  computedAt: string | null;
  now: string;
}) {
  const peek = usePeek();
  const open = peek.id === DETAILS_PEEK;
  return (
    <Panel
      open={open}
      onOpenChange={(next) => {
        if (!next) peek.close();
      }}
      title="Self-corrections in detail"
      subtitle={computedAt ? <>Read {formatRelativeTime(computedAt, now)}</> : undefined}
    >
      <DetailsBody stats={stats} kinds={kinds} computedAt={computedAt} now={now} />
    </Panel>
  );
}

/** The Panel's body: every number with what it counts, the kinds with their meanings, and when it was read. */
export function DetailsBody({
  stats,
  kinds,
  computedAt,
  now,
}: {
  stats: readonly StatView[];
  kinds: readonly KindRow[];
  computedAt: string | null;
  now: string;
}) {
  const most = Math.max(0, ...kinds.map((row) => row.events));
  return (
    <div className="flex flex-col gap-6" data-corrections-details="">
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-3 text-ui">
        {stats.map((stat) => (
          <div key={stat.label} className="contents">
            <dt className="flex flex-col">
              <span className="text-fg">{stat.label}</span>
              {stat.hint ? <span className="text-xs text-fg-subtle">{stat.hint}</span> : null}
            </dt>
            <dd className="text-right font-medium text-fg tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="corrections-kinds" className="flex flex-col gap-2">
        <h3 id="corrections-kinds" className="text-sm font-semibold text-fg">
          By kind
        </h3>
        <ul className="flex flex-col">
          {kinds.map((row) => {
            const Icon = KIND_ICONS[row.kind];
            return (
              <li
                key={row.kind}
                className="flex items-start gap-3 border-b border-line py-2"
                data-kind-detail={row.kind}
              >
                <Icon
                  aria-hidden
                  strokeWidth={1.5}
                  className="mt-0.5 size-4 shrink-0 text-fg-subtle"
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-ui",
                      row.measured && row.events > 0 ? "text-fg" : "text-fg-subtle",
                    )}
                  >
                    {row.label}
                  </p>
                  <p className="text-xs text-fg-subtle">
                    {row.measured ? PLAIN_KIND_MEANINGS[row.kind] : "Needs content capture."}
                  </p>
                </div>
                {row.measured ? (
                  <>
                    <DotMeter
                      value={most > 0 ? row.events / most : 0}
                      cells={10}
                      tone="neutral"
                      label={`${row.label}: ${Math.round(row.share * 100)}% of self-corrections`}
                      className="mt-1.5 shrink-0"
                    />
                    <span className="w-10 shrink-0 text-right text-ui text-fg tabular-nums">
                      {formatCount(row.events)}
                    </span>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
      {computedAt ? (
        <p className="text-xs text-fg-subtle">
          Read{" "}
          <time dateTime={computedAt} title={formatTimestamp(computedAt)}>
            {formatRelativeTime(computedAt, now)}
          </time>
          . The agent&apos;s replies are read only when content capture is on.
        </p>
      ) : null}
    </div>
  );
}
