import { Badge, StatusDot } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { Check, Sparkles, X } from "lucide-react";
import type { EvalRunKind, EvalRunStatus } from "@/lib/views/evals/domain/types";
import type { CellMark, ResultMark, RowChange } from "@/lib/views/evals/view";

/** The marks the Evals tables share: a check, a cross or a dot, never color alone (DESIGN.md, Color). */

export const RUN_KIND_LABELS: Record<EvalRunKind, string> = {
  manual: "Manual",
  nightly: "Nightly",
  simulation: "Simulation",
};
export const CHANGE_WORDS: Record<RowChange, string> = {
  now_fails: "Now fails",
  fixed: "Fixed",
  same: "",
  new: "New",
  broke: "Broke",
  unverified: "Unverified",
};
export const CHANGE_TONE: Record<RowChange, string> = {
  now_fails: "text-danger",
  broke: "text-danger",
  fixed: "text-success",
  unverified: "text-warning",
  same: "text-fg-muted",
  new: "text-fg-muted",
};

/** One scorer's cell: a check, a cross, or a dot when the scorer does not apply. `outlined` marks a changed result. */
export function CellIcon({ mark, outlined = false }: { mark: CellMark; outlined?: boolean }) {
  if (mark === "dot")
    return (
      <span className="text-fg-faint" aria-label="Does not apply" title="Does not apply">
        ·
      </span>
    );
  const pass = mark === "pass";
  const Icon = pass ? Check : X;
  return (
    <span
      data-mark={mark}
      data-outlined={outlined ? "" : undefined}
      aria-label={pass ? "Pass" : "Fail"}
      title={pass ? "Pass" : "Fail"}
      className={cn(
        "inline-flex size-5 items-center justify-center rounded-sm",
        pass ? "text-success" : "bg-danger-subtle text-danger",
        outlined && "ring-1 ring-current",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}

/** One eval's result in words with a dot. */
export function ResultStatus({ mark }: { mark: ResultMark | null }) {
  if (mark === "pass") return <StatusDot tone="success" label="Passes" />;
  if (mark === "fail") return <StatusDot tone="danger" label="Fails" />;
  if (mark === "error") return <StatusDot tone="warning" label="Could not run" />;
  return <StatusDot tone="neutral" label="Not run yet" />;
}

/** The last runs of one eval, oldest first: one small bar each. */
export function LastRuns({ marks }: { marks: readonly ResultMark[] }) {
  const words = { pass: "passed", fail: "failed", error: "could not run", none: "no run" } as const;
  return (
    <span
      className="inline-flex items-center gap-0.5"
      aria-label={`Last ${marks.length} runs, oldest first: ${marks.map((mark) => words[mark]).join(", ")}`}
    >
      {marks.map((mark, index) => (
        <span
          key={index}
          data-mark={mark}
          aria-hidden
          className={cn(
            "h-3.5 w-2 rounded-[2px]",
            mark === "pass" && "bg-success",
            mark === "fail" && "bg-danger",
            mark === "error" && "bg-warning",
            mark === "none" && "border border-dashed border-line-strong",
          )}
        />
      ))}
    </span>
  );
}

/** A run's status as a word with a dot; a completed run needs none. */
export function RunStatus({ status }: { status: EvalRunStatus }) {
  if (status === "queued") return <StatusDot tone="neutral" label="Queued" />;
  if (status === "running") return <StatusDot tone="info" label="Running" />;
  if (status === "failed") return <StatusDot tone="danger" label="Failed" />;
  return null;
}

/**
 * RC-657: the one mark of a value a model wrote when the eval was made (UX
 * audit RC-656, P6). Info tone, never warning: a generated value is not an
 * error. A value a person set never has it.
 */
export function GeneratedMark() {
  return (
    <span className="inline-flex" data-generated-mark>
      <Badge tone="info" className="gap-1">
        <Sparkles className="size-3" aria-hidden />
        Generated
      </Badge>
    </span>
  );
}

/** RC-657: where a value comes from, in words after it: "Suite default", "Task limit", "This eval". */
export function SourceNote({ children }: { children: string }) {
  return (
    <span className="text-xs text-fg-subtle" data-source-note>
      · {children}
    </span>
  );
}
