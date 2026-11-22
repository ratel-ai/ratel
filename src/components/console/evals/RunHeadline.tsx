import { Callout } from "@ratel/design-system/states";
import type { EvalRun } from "@/lib/views/evals/domain/types";
import { changeText, type RunSummary } from "@/lib/views/evals/view";

const TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

/** One run's line above its table: the pass count and the change, or what the run is doing (queued, running, failed). */
export function RunHeadline({
  run,
  summary,
  previous,
}: {
  run: EvalRun;
  summary: RunSummary;
  previous: EvalRun | null;
}) {
  if (run.status === "queued")
    return (
      <Callout title="Queued">
        The run starts within a minute. This page shows its results when it finishes.
      </Callout>
    );
  if (run.status === "running")
    return (
      <Callout title="Running">{`Replaying ${run.evalCount} ${run.evalCount === 1 ? "eval" : "evals"} against the agent as recorded. Reload to see the results.`}</Callout>
    );
  if (run.status === "failed")
    return (
      <Callout tone="danger" title="The run failed">
        {run.error ?? "Run all again to retry."}
      </Callout>
    );
  const change = changeText(summary);
  return (
    <p className="text-ui text-fg-muted">
      <span className="font-semibold text-fg">
        {summary.passed} of {summary.total} pass
      </span>
      {previous ? <> · compared with {TIME.format(previous.createdAt)}</> : <> · the first run</>}
      {change ? (
        <>
          {" "}
          · <span className={summary.nowFails > 0 ? "text-danger" : "text-success"}>{change}</span>
        </>
      ) : null}
    </p>
  );
}
