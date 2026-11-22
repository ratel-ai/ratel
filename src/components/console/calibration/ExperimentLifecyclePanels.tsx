import type {
  ExperimentLifecycleArmMetrics,
  ExperimentLifecycleDiagnostics,
} from "@/lib/synthesis/experiments/types";

/*
 * Reliability's accent used the brand's `indigo-300` (#9b8cff) as a solid fill —
 * a high-chroma violet that glares against the near-black instrument surfaces and
 * fights the coral accent for attention. It is `ctx-memory` (the data-viz steel
 * blue) throughout now: the same "shadow arm, not the serving arm" distinction at
 * a far lower intensity, and already the palette's cool counterpart to coral.
 */

export function ExperimentLifecyclePanels({
  metrics,
  diagnostics,
}: {
  metrics: readonly ExperimentLifecycleArmMetrics[];
  diagnostics: ExperimentLifecycleDiagnostics;
}) {
  return (
    <section aria-labelledby="experiment-lifecycle-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Decision telemetry</div>
          <h2
            id="experiment-lifecycle-title"
            className="mt-1 font-display text-lg font-semibold tracking-tight text-cream"
          >
            Shadow agreement &amp; reliability
          </h2>
        </div>
        <p className="max-w-xl text-pretty text-left text-xs leading-relaxed text-warm-muted sm:text-right">
          Rank agreement and the shadow evaluation funnel, windowed by lifecycle event time.
        </p>
      </div>

      {!diagnostics.hasLifecycleEvents ? (
        <MissingLifecycleState latestLogAt={diagnostics.latestLogAt} />
      ) : metrics.length === 0 ? (
        <ZeroMetricsState latestLogAt={diagnostics.latestLogAt} />
      ) : (
        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <AgreementPanel metrics={metrics} />
          <ReliabilityPanel metrics={metrics} />
        </div>
      )}
    </section>
  );
}

function AgreementPanel({ metrics }: { metrics: readonly ExperimentLifecycleArmMetrics[] }) {
  return (
    <article className="card-enter overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/35">
      <PanelHeader
        label="Agreement"
        description="How closely each shadow arm preserves the serving arm's ordered results."
        accent="coral"
      />
      <div className="divide-y divide-forest-300/55">
        {metrics.map((arm) => (
          <div key={arm.arm} className="px-4 py-3">
            <ArmHeader arm={arm.arm} role={arm.role} />
            <dl className="mt-2.5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-forest-300 bg-forest-300 sm:grid-cols-4">
              <MetricTile label="Top-1" value={formatPercent(arm.top1Rate)} />
              <MetricTile label="Exact order" value={formatPercent(arm.exactOrderRate)} />
              <MetricTile
                label={arm.agreementK === null ? "Jaccard" : `Jaccard@${arm.agreementK}`}
                value={formatDecimal(arm.averageJaccardAtK)}
              />
              <MetricTile
                label="Sample"
                value={arm.comparisonCount.toLocaleString("en-US")}
                detail={`${arm.comparisonCount.toLocaleString("en-US")} comparisons`}
              />
            </dl>
          </div>
        ))}
      </div>
    </article>
  );
}

function ReliabilityPanel({ metrics }: { metrics: readonly ExperimentLifecycleArmMetrics[] }) {
  return (
    <article className="card-enter overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/35 [animation-delay:80ms]">
      <PanelHeader
        label="Reliability"
        description="How often shadow work reaches comparison, including skips, fallbacks, and drops."
        accent="steel"
      />
      <div className="divide-y divide-forest-300/55">
        {metrics.map((arm) => (
          <div key={arm.arm} className="px-4 py-3">
            <ArmHeader arm={arm.arm} role={arm.role} />
            <div className="mt-2.5 flex items-end justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-warm-muted">
                  Shadow coverage
                </div>
                <div className="mt-0.5 font-display text-2xl font-semibold tabular-nums text-cream">
                  {formatPercent(arm.shadowCoverage)}
                </div>
              </div>
              <div className="font-mono text-[9px] text-warm-muted">
                comparisons ÷ (comparisons + drops + skips)
              </div>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-base-deep/70" aria-hidden>
              <div
                className="h-full rounded-full bg-ctx-memory"
                style={{ width: coverageWidth(arm.shadowCoverage) }}
              />
            </div>
            <dl className="mt-2.5 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-forest-300 bg-forest-300">
              <MetricTile label="Skips" value={formatCount(arm.skipCount)} />
              <MetricTile label="Fallbacks" value={formatCount(arm.fallbackCount)} />
              <MetricTile label="Drops" value={formatCount(arm.dropCount)} />
            </dl>
            {arm.dropCount > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(arm.dropsByReason)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([reason, count]) => (
                    <span
                      key={reason}
                      className="rounded-md border border-coral/25 bg-coral/8 px-2 py-1 font-mono text-[9px] text-coral"
                    >
                      {reason} · {count.toLocaleString("en-US")}
                    </span>
                  ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}

function PanelHeader({
  label,
  description,
  accent,
}: {
  label: string;
  description: string;
  accent: "coral" | "steel";
}) {
  return (
    <header className="border-b border-forest-300 bg-base-deep/25 px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className={
            accent === "coral"
              ? "size-2 rounded-full bg-coral"
              : "size-2 rounded-full bg-ctx-memory"
          }
          aria-hidden
        />
        <h3 className="font-display text-sm font-semibold text-cream">{label}</h3>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-warm-muted">{description}</p>
    </header>
  );
}

function ArmHeader({ arm, role }: { arm: string; role: "shadow" }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate font-mono text-xs font-medium text-cream" title={arm}>
        {arm}
      </span>
      <span className="rounded-md border border-ctx-memory/25 bg-ctx-memory/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ctx-memory">
        {role}
      </span>
    </div>
  );
}

function MetricTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="bg-base-deep/35 px-3 py-2.5 text-right">
      <dt className="text-[10px] text-warm-muted">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm font-medium tabular-nums text-cream">{value}</dd>
      {detail && <div className="sr-only">{detail}</div>}
    </div>
  );
}

function MissingLifecycleState({ latestLogAt }: { latestLogAt: Date | null }) {
  return (
    <div className="mt-3 rounded-2xl border border-dashed border-coral/35 bg-coral/[0.055] px-5 py-6">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-coral">
        No lifecycle events received in this window
      </div>
      <p className="mt-2 max-w-3xl text-xs leading-relaxed text-cream-dim">
        Agreement and funnel metrics require SDK ≥ ratel-ai/ratel#140. Confirm the SDK version
        before treating this as a genuine zero.
      </p>
      {latestLogAt && <LatestEvent value={latestLogAt} />}
    </div>
  );
}

function ZeroMetricsState({ latestLogAt }: { latestLogAt: Date | null }) {
  return (
    <div className="mt-3 rounded-2xl border border-dashed border-forest-300 bg-forest-600/20 px-5 py-6">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-green">
        Lifecycle events are arriving
      </div>
      <p className="mt-2 text-xs leading-relaxed text-warm-muted">
        No shadow metrics for this experiment in the selected window. This is a genuine zero, not an
        ingestion gap.
      </p>
      {latestLogAt && <LatestEvent value={latestLogAt} />}
    </div>
  );
}

function LatestEvent({ value }: { value: Date }) {
  return (
    <p className="mt-2 font-mono text-[9px] text-warm-muted">
      Latest project lifecycle event · {formatDate(value)}
    </p>
  );
}

function formatPercent(value: number | null): string {
  return value === null
    ? "—"
    : `${(value * 100).toLocaleString("en-US", {
        maximumFractionDigits: 1,
      })}%`;
}

function formatDecimal(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function coverageWidth(value: number | null): string {
  if (value === null) return "0%";
  return `${Math.min(1, Math.max(0, value)) * 100}%`;
}

function formatDate(value: Date): string {
  return value.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}
