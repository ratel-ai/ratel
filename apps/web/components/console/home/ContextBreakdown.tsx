import { DotMeter } from "@ratel/design-system/dot-matrix";
import { EmptyState } from "@ratel/design-system/states";
import { fmtCount } from "@/lib/platform/format";
import { formatSharePercent } from "@/lib/readings/trace-signals/claims";
import { fmtTokens, type Suggestion } from "@/lib/synthesis/dashboard";
import type { ContextSplit } from "@/lib/views/home/overview-model";

const DOCS_URL = "https://docs.ratel.sh";

/**
 * What used to be the Dashboards page, at the depth it deserves: the prompt
 * split by source with the measurable waste inside each, then what to do
 * about the biggest parts.
 */
export function ContextBreakdown({
  split,
  suggestions,
}: {
  split: ContextSplit | null;
  suggestions: readonly Suggestion[];
}) {
  if (!split) {
    return (
      <EmptyState
        emblem
        title="No context breakdown yet"
        description="The Ratel SDK reports how each prompt splits into tools, skills, history and memory. Runs sent over OpenTelemetry alone do not carry it."
        secondary={
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-ui text-fg-muted underline decoration-line-strong underline-offset-4 hover:text-fg"
          >
            Read the SDK docs
          </a>
        }
      />
    );
  }

  const perRun = split.runs > 0 ? split.totalTokens / split.runs : null;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-fg-muted">
        <span className="font-medium text-fg tabular-nums">{fmtTokens(split.totalTokens)}</span>{" "}
        context tokens across <span className="tabular-nums">{fmtCount(split.runs)}</span>{" "}
        {split.runs === 1 ? "run" : "runs"}
        {perRun === null ? "" : `, about ${fmtTokens(perRun)} per run`}.
      </p>

      <ul className="flex flex-col gap-3">
        {split.rows.map((row) => (
          <li
            key={row.source}
            className="grid grid-cols-[6rem_minmax(0,1fr)_3rem_2.75rem] items-center gap-x-3 gap-y-1"
          >
            <span className="truncate text-ui font-medium text-fg">{row.label}</span>
            <DotMeter
              value={row.share}
              cells={36}
              tone="neutral"
              label={`${row.label}: share of context`}
            />
            <span className="text-right text-xs text-fg-subtle tabular-nums">
              {fmtTokens(row.tokens)}
            </span>
            <span className="text-right text-ui font-medium text-fg tabular-nums">
              {formatSharePercent(row.share)}
            </span>
            {row.waste ? (
              <p className="col-start-2 col-end-5 text-xs text-fg-muted">
                <span className="font-medium text-warning tabular-nums">
                  {formatSharePercent(row.waste.share)}
                </span>{" "}
                {row.waste.label}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {suggestions.length > 0 ? (
        <section
          aria-labelledby="context-suggestions"
          className="flex flex-col gap-3 border-t border-line pt-5"
        >
          <h3 id="context-suggestions" className="text-sm font-semibold text-fg">
            What to do
          </h3>
          <ul className="flex flex-col gap-4">
            {suggestions.map((suggestion) => (
              <li key={suggestion.source} className="flex flex-col gap-1">
                <p className="text-ui font-medium text-fg">{suggestion.title}</p>
                <p className="text-ui text-pretty text-fg-muted">{suggestion.body}</p>
                <p className="text-xs text-fg-subtle">
                  Next step: <span className="text-fg-muted">{suggestion.manual}</span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
