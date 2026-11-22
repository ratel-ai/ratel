import type { ArmRoleBreakdown } from "@/lib/synthesis/experiments/calibration-types";

const ARM_ACCENTS = [
  {
    border: "border-coral/30",
    dot: "bg-coral",
    glow: "shadow-[0_0_12px_rgb(251_113_133_/_0.3)]",
  },
  {
    border: "border-indigo-300/35",
    dot: "bg-indigo-300",
    glow: "shadow-[0_0_12px_rgb(165_180_252_/_0.3)]",
  },
] as const;

/** Per-arm serving/shadowing share without assigning either arm a fixed role. */
export function ArmRoleMix({ arms }: { arms: ArmRoleBreakdown[] }) {
  if (arms.length === 0) return null;
  return (
    <section aria-labelledby="arm-role-mix-title">
      <div className="eyebrow">Experiment arms</div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="arm-role-mix-title"
          className="font-display text-lg font-semibold tracking-tight text-cream"
        >
          Serving and shadowing mix
        </h2>
        <p className="text-xs text-warm-muted">Role share across comparisons with known arms</p>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {arms.map((arm, index) => {
          const accent = ARM_ACCENTS[index % ARM_ACCENTS.length];
          return (
            <article
              key={arm.arm}
              className={`card-enter overflow-hidden rounded-2xl border bg-forest-600/45 ${accent.border}`}
              style={{ animationDelay: `${index * 80}ms` }}
            >
              <header className="flex items-center gap-3 border-b border-forest-300/60 bg-base-deep/30 px-4 py-3">
                <span className={`size-2 rounded-full ${accent.dot} ${accent.glow}`} aria-hidden />
                <h3 className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-cream">
                  {arm.arm}
                </h3>
                <span className="font-mono text-[10px] tabular-nums text-warm-muted">
                  {(arm.servingCount + arm.shadowingCount).toLocaleString("en-US")} seen
                </span>
              </header>
              <dl className="grid grid-cols-2 divide-x divide-forest-300/60">
                <RoleShare
                  label="serving"
                  rate={arm.servingRate}
                  count={arm.servingCount}
                  tone="text-coral"
                />
                <RoleShare
                  label="shadowing"
                  rate={arm.shadowingRate}
                  count={arm.shadowingCount}
                  tone="text-indigo-300"
                />
              </dl>
              <div className="flex h-1 bg-forest-300/35" aria-hidden>
                <span
                  className="bg-coral transition-[width] duration-500"
                  style={{ width: `${arm.servingRate * 100}%` }}
                />
                <span
                  className="bg-indigo-300 transition-[width] duration-500"
                  style={{ width: `${arm.shadowingRate * 100}%` }}
                />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function RoleShare({
  label,
  rate,
  count,
  tone,
}: {
  label: string;
  rate: number;
  count: number;
  tone: string;
}) {
  return (
    <div className="px-4 py-3">
      <dt className="font-mono text-[10px] uppercase tracking-wide text-warm-muted">{label}</dt>
      <dd className={`mt-1 font-display text-2xl font-semibold tabular-nums ${tone}`}>
        {formatRate(rate)}
      </dd>
      <div className="font-mono text-[10px] tabular-nums text-warm-muted">
        {count.toLocaleString("en-US")} comparison{count === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function formatRate(value: number): string {
  return `${(value * 100).toLocaleString("en-US", {
    maximumFractionDigits: 1,
  })}%`;
}
