import { Badge, type Tone } from "@ratel/design-system/badge";
import { Section } from "@ratel/design-system/section";
import Link from "next/link";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { Counts } from "@/lib/views/evals/domain/experiment";
import type { ExperimentRow } from "@/lib/views/evals/page-model";
import { experimentHref } from "@/lib/views/evals/paths";

const RESULTS: Array<{ key: keyof Counts; label: string; tone: Tone }> = [
  { key: "pass", label: "pass", tone: "success" },
  { key: "fail", label: "fail", tone: "danger" },
  { key: "invalid", label: "invalid", tone: "warning" },
  { key: "open", label: "open", tone: "info" },
];

/** The experiments, the newest first. */
export function ExperimentList({
  projectId,
  experiments,
  now,
}: {
  projectId: string;
  experiments: ExperimentRow[];
  now: string;
}) {
  if (experiments.length === 0) return null;
  return (
    <Section
      title="Experiments"
      description="An experiment never changes. A new run makes a new one."
    >
      <ul className="divide-y divide-line rounded-lg border border-line bg-raised">
        {experiments.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
            <Link
              href={experimentHref(projectId, row.id)}
              className="text-ui font-medium text-fg underline-offset-2 hover:underline"
            >
              {row.sandboxName} · {row.commit.slice(0, 12)}
            </Link>
            <StateBadge state={row.state} />
            <CountBadges counts={row.counts} />
            <span className="ml-auto text-xs text-fg-subtle" title={row.createdAt}>
              {formatRelativeTime(row.createdAt, now)}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function StateBadge({ state }: { state: ExperimentRow["state"] }) {
  return state === "running" ? (
    <Badge tone="info">Running</Badge>
  ) : (
    <Badge tone="neutral">Completed</Badge>
  );
}

/** The raw counts. The three results always show, also when one is 0. */
export function CountBadges({ counts }: { counts: Counts }) {
  return (
    <span className="flex flex-wrap gap-2">
      {RESULTS.filter(({ key }) => key !== "open" || counts.open > 0).map(
        ({ key, label, tone }) => (
          <Badge key={key} tone={counts[key] > 0 ? tone : "neutral"}>
            {counts[key]} {label}
          </Badge>
        ),
      )}
    </span>
  );
}
