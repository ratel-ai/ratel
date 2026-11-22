import { Badge } from "@ratel/design-system/badge";
import type { DefinitionRow } from "@/lib/views/evals/view";

/** An eval's name, its Suggested label (RC-315) and, for a score-based suggestion, the reading that made it (RC-616). */
export function EvalNameCell({
  row,
}: {
  row: Pick<DefinitionRow, "name" | "suggested" | "reason">;
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-2">
        <span className="truncate text-fg">{row.name}</span>
        {row.suggested ? <Badge tone="info">Suggested</Badge> : null}
      </span>
      {row.reason ? (
        <span className="truncate text-xs text-fg-muted">{reasonText(row.reason)}</span>
      ) : null}
    </span>
  );
}

/** RC-658: "Answer quality: 20%, passes at 70%". One unit, the percent of the scorer page. */
export function reasonText(reason: NonNullable<DefinitionRow["reason"]>): string {
  return `${reason.scorerName}: ${percent(reason.value)}, passes at ${percent(reason.threshold)}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
