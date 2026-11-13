import { Badge } from "@ratel/design-system/badge";
import { formatClock } from "@/lib/synthesis/traces/v2/format";
import { logPresentation, salientAttributes } from "@/lib/synthesis/traces/v2/logs";

export interface LifecycleRecord {
  id: string;
  eventName: string;
  occurredAt: string;
  experimentName: string | null;
  experimentArm: string | null;
  experimentRole: string | null;
  experimentAttrs: Record<string, unknown>;
}

/** DESIGN.md, Glossary: the served arm is the current variant, a shadow one the comparison. */
const ROLE: Readonly<Record<string, string>> = {
  served: "current",
  serving: "current",
  shadow: "comparison",
};

const TONE = {
  neutral: "neutral",
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "info",
} as const;

/**
 * What the ranking experiment recorded for this run, in order: which variant
 * answered, how the variants compared, and anything skipped or dropped. Only
 * shown when the run has such records.
 */
export function TraceRanking({ records }: { records: readonly LifecycleRecord[] }) {
  return (
    <ol
      className="flex max-w-4xl flex-col rounded-lg border border-line"
      aria-label="Ranking records"
      data-ranking
    >
      {records.map((record) => {
        const presentation = logPresentation(record.eventName);
        const attributes = salientAttributes(record.experimentAttrs);
        return (
          <li
            key={record.id}
            className="flex flex-col gap-1.5 border-b border-line px-4 py-3 last:border-b-0"
          >
            <div className="flex flex-wrap items-center gap-2 text-ui">
              <Badge tone={TONE[presentation.tone]}>{presentation.label}</Badge>
              {record.experimentArm ? (
                <span className="text-fg">
                  Variant {record.experimentArm}
                  {record.experimentRole ? (
                    <span className="text-fg-subtle">
                      {" "}
                      ({ROLE[record.experimentRole] ?? record.experimentRole})
                    </span>
                  ) : null}
                </span>
              ) : null}
              {record.experimentName ? (
                <span className="text-fg-subtle">in {record.experimentName}</span>
              ) : null}
              <time
                dateTime={record.occurredAt}
                className="ml-auto text-xs text-fg-subtle tabular-nums"
              >
                {formatClock(record.occurredAt, true)} UTC
              </time>
            </div>
            <p className="text-xs text-fg-muted">{presentation.description}</p>
            {attributes.length > 0 ? (
              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {attributes.map((attribute) => (
                  <div key={attribute.key} className="flex min-w-0 gap-1.5">
                    <dt className="text-fg-subtle">{attribute.label}</dt>
                    <dd className="max-w-64 truncate text-fg tabular-nums" title={attribute.value}>
                      {attribute.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
