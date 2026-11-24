import { Section } from "@ratel/design-system/section";
import Link from "next/link";
import { formatPercent } from "@/lib/synthesis/traces/v2/format";
import { scorersHref } from "@/lib/views/scorers/paths";
import type { ScoreOfTrace } from "@/lib/views/scorers/store";
import { ScoreValue } from "./parts";

/** What the project's scorers gave one trace. Nothing without a result. */
export function TraceScores({
  projectId,
  scores,
}: {
  projectId: string;
  scores: readonly ScoreOfTrace[];
}) {
  if (scores.length === 0) return null;
  return (
    <Section title="Scores">
      <ul className="flex flex-wrap gap-2">
        {scores.map((score) => (
          <li
            key={score.scorerId}
            className="flex items-center gap-3 rounded-md border border-line px-2.5 py-1.5 text-ui"
          >
            <Link
              href={`${scorersHref(projectId)}/${score.scorerId}`}
              className="text-fg-muted hover:underline"
            >
              {score.scorerName}
            </Link>
            <ScoreValue score={score} />
            {score.confidence !== null ? (
              <span className="text-xs text-fg-subtle tabular-nums">
                {formatPercent(score.confidence)} confident
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
