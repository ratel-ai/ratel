import { EmptyState } from "@ratel/design-system/states";

const HOW = ["Search an ask", "Pick the tool that should win", "Rewrite its description"] as const;

/**
 * Before the first search. The real asks to try are the chips right above, so
 * this only names the part nobody would guess on their own: that a description
 * can be rewritten and tested here.
 */
export function FirstRun() {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-line">
      <EmptyState emblem title="See which tools your agent would find" className="pb-6" />
      <ol className="mb-10 flex flex-col gap-3 px-6 sm:flex-row sm:gap-8" aria-label="How it works">
        {HOW.map((step, index) => (
          <li key={step} className="flex items-center gap-2 text-ui text-fg-muted">
            <span
              aria-hidden
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-line text-xs text-fg-subtle tabular-nums"
            >
              {index + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}
