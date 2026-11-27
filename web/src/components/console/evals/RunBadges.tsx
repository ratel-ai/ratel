import { Badge, type Tone } from "@ratel/design-system/badge";
import type { Counts, ExperimentState } from "@/lib/views/evals/domain/experiment";

const RESULTS: Array<{ key: keyof Counts; label: string; tone: Tone }> = [
  { key: "pass", label: "pass", tone: "success" },
  { key: "fail", label: "fail", tone: "danger" },
  { key: "invalid", label: "invalid", tone: "warning" },
  { key: "open", label: "open", tone: "info" },
];

/** Whether a run still runs. */
export function StateBadge({ state }: { state: ExperimentState }) {
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
