"use client";

import { Button } from "@ratel/design-system/button";
import { Switch } from "@ratel/design-system/checkbox";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { ScorerActionInput, ScorerActionResult } from "@/lib/views/task-scorers/actions";
import { FINISHES_CLEANLY_HELP, SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import type { TaskScorer } from "@/lib/views/task-scorers/store";
import { SCORER_KINDS, type Scorer, type ScorerKind } from "@/lib/views/task-scorers/types";
import { changeTaskScorerAction } from "./actions";

export { SCORER_LABELS } from "@/lib/views/task-scorers/labels";

const FIELD_LABELS: Partial<Record<ScorerKind, string>> = {
  max_self_corrections: "Maximum corrections",
  max_latency_ms: "Maximum time (ms)",
  max_cost_usd: "Maximum cost (USD)",
  expected_tool: "Tool ID",
  max_tool_calls: "Maximum calls",
  judge_criteria: "Passing criteria",
};

export function Scorers({
  projectId,
  taskId,
  scorers,
}: {
  projectId: string;
  taskId: string;
  scorers: readonly TaskScorer[];
}) {
  return (
    <Section
      title="Scorers"
      description="Set what counts as a passing run. Changes apply to the next scoring job."
    >
      <div className="divide-y divide-line border-y border-line">
        {SCORER_KINDS.map((kind) => {
          const scorer = scorers.find((item) => item.kind === kind);
          return (
            <ScorerForm
              key={`${kind}:${JSON.stringify(scorer)}`}
              projectId={projectId}
              taskId={taskId}
              kind={kind}
              scorer={scorer}
            />
          );
        })}
      </div>
    </Section>
  );
}

function ScorerForm({
  projectId,
  taskId,
  kind,
  scorer,
}: {
  projectId: string;
  taskId: string;
  kind: ScorerKind;
  scorer?: TaskScorer;
}) {
  const router = useRouter();
  const initial =
    scorer && "max" in scorer
      ? String(scorer.max)
      : scorer && "tool" in scorer
        ? scorer.tool
        : scorer && "criteria" in scorer
          ? scorer.criteria
          : "";
  const [value, setValue] = useState(initial);
  const [enabled, setEnabled] = useState(scorer?.enabled ?? false);
  const [result, setResult] = useState<ScorerActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = value !== initial || enabled !== (scorer?.enabled ?? false);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function commit(input: ScorerActionInput) {
    setResult(null);
    startTransition(async () => {
      const next = await changeTaskScorerAction(input);
      setResult(next);
      if (next.ok) router.refresh();
    });
  }

  function save() {
    const next: Scorer =
      kind === "ends_well"
        ? { kind }
        : kind === "expected_tool"
          ? { kind, tool: value }
          : kind === "judge_criteria"
            ? { kind, criteria: value }
            : { kind, max: Number(value) };
    commit({ projectId, taskId, action: "save", scorer: next, enabled });
  }

  return (
    <form
      aria-label={`${SCORER_LABELS[kind]} scorer`}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      className="flex flex-wrap items-end gap-x-5 gap-y-3 py-4"
    >
      <div className="min-w-36 flex-1 basis-40 self-center">
        <h3 className="text-sm font-medium text-fg">{SCORER_LABELS[kind]}</h3>
        <p className="mt-1 text-xs text-fg-subtle">
          {scorer?.source === "user" ? "Your settings" : scorer ? "Default" : "Not configured"}
        </p>
      </div>
      <Switch
        label="Enabled"
        checked={enabled}
        onCheckedChange={setEnabled}
        disabled={pending}
        className="self-center"
      />
      {kind !== "ends_well" ? (
        <Field label={FIELD_LABELS[kind]} className="w-48 max-sm:w-full">
          {(control) =>
            kind === "judge_criteria" ? (
              <Textarea
                {...control}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                maxLength={5000}
                required
                disabled={pending}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    save();
                  }
                }}
              />
            ) : (
              <Input
                {...control}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                type={kind === "expected_tool" ? "text" : "number"}
                min={0}
                step={kind === "max_tool_calls" || kind === "max_self_corrections" ? 1 : "any"}
                required
                disabled={pending}
                autoComplete="off"
              />
            )
          }
        </Field>
      ) : (
        <p className="w-48 self-center text-xs text-fg-subtle">{FINISHES_CLEANLY_HELP}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" size="sm" loading={pending}>
          Save scorer
        </Button>
        {scorer?.source === "user" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => commit({ projectId, taskId, action: "reset", kind })}
          >
            Reset to default
          </Button>
        ) : null}
      </div>
      <p
        className={`basis-full text-xs ${result && !result.ok ? "text-danger" : "text-fg-subtle"}`}
        aria-live="polite"
        role={result && !result.ok ? "alert" : undefined}
      >
        {result ? (result.ok ? "Scorer updated." : result.error) : null}
      </p>
    </form>
  );
}
