import { cn } from "@ratel/design-system/cn";
import Link from "next/link";
import type { ExperimentMode } from "@/lib/synthesis/experiments/types";

const MODE_COPY: Record<ExperimentMode, { label: string; className: string }> = {
  split: {
    label: "split",
    className: "border-indigo-300/30 bg-indigo-300/10 text-indigo-300",
  },
  shadow: {
    label: "shadow",
    className: "border-ctx-tools/35 bg-ctx-tools/10 text-ctx-tools",
  },
  mixed: {
    label: "mixed",
    className: "border-coral/35 bg-coral/10 text-coral",
  },
};

export function ExperimentBadge({
  name,
  arm,
  mode,
  href,
  className,
}: {
  name?: string | null;
  arm?: string | null;
  mode?: ExperimentMode;
  href?: string;
  className?: string;
}) {
  const modeCopy = mode ? MODE_COPY[mode] : null;
  const content = (
    <>
      <span className="size-1.5 shrink-0 rounded-full bg-current opacity-80" aria-hidden />
      {modeCopy ? (
        modeCopy.label
      ) : (
        <>
          <span className="truncate">{name || "unnamed"}</span>
          {arm && (
            <span className="shrink-0 border-l border-current/20 pl-1.5 opacity-70">{arm}</span>
          )}
        </>
      )}
    </>
  );
  const classes = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1",
    "font-mono text-[10px] tracking-[0.04em]",
    mode && "uppercase",
    modeCopy?.className ?? "border-indigo-300/25 bg-indigo-300/10 text-indigo-300",
    href && "min-h-7 transition-colors hover:border-current/50 hover:bg-indigo-300/15",
    className,
  );
  const title = mode ? `${modeCopy!.label} experiment` : [name, arm].filter(Boolean).join(" / ");

  return href ? (
    <Link href={href} className={classes} title={title}>
      {content}
    </Link>
  ) : (
    <span className={classes} title={title}>
      {content}
    </span>
  );
}

export function RankingExperimentBadge({ label = "ranking" }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-ctx-tools/35 bg-ctx-tools/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.04em] text-ctx-tools"
      title="ranking-shadow experiment"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current opacity-80" aria-hidden />
      {label}
    </span>
  );
}
