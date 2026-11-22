"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button, IconButton } from "@ratel/design-system/button";
import { Checkbox } from "@ratel/design-system/checkbox";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState, useTransition } from "react";
import {
  addEvalRunAction,
  addRunsFromHistoryAction,
  createEvalSetAction,
  type EvalActionResult,
  removeEvalCaseAction,
  runFixSimulationAction,
  updateEvalCaseAction,
} from "@/app/(console)/project/[projectId]/improvement/fixes/eval-actions";
import type { EvalCaseRow, EvalGatePageModel } from "@/lib/views/eval-gate/page-model";
import type { SideResult } from "@/lib/views/eval-gate/types";
import { CHECK_LABELS } from "@/lib/views/eval-gate/types";
import { FINISHES_CLEANLY_HELP } from "@/lib/views/task-scorers/labels";

/**
 * The eval page's interactive parts: run a simulation, pick runs, the runs
 * table with each run's expected outcome editable in a Dialog, removal with
 * Undo, and adding a run by id. Every mutation is a server action that
 * re-checks membership and the flag.
 */

async function settle(action: () => Promise<EvalActionResult>): Promise<EvalActionResult> {
  try {
    return await action();
  } catch {
    return { ok: false, message: "Something went wrong. Try again in a moment." };
  }
}

/** While a simulation runs, ask for its badge every few seconds and refresh when it lands. */
export function EvalPoller({ projectId, fixId }: { projectId: string; fixId: string }) {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/fixes/eval?fix=${encodeURIComponent(fixId)}`,
          { cache: "no-store" },
        );
        const body = (await response.json()) as { ok?: boolean; badge?: { state?: string } };
        if (!stopped && body.ok && body.badge?.state !== "pending") {
          window.clearInterval(timer);
          router.refresh();
        }
      } catch {
        // A missed poll is retried on the next tick.
      }
    }, 2500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [projectId, fixId, router]);
  return (
    <p aria-live="polite" className="sr-only">
      Simulating on your past runs
    </p>
  );
}

/**
 * "Run simulation". `blocked` (RC-77) is why the fix has nothing to simulate:
 * the button is disabled and described by `reasonId`, the visible reason.
 */
export function RunSimulationButton({
  projectId,
  fixId,
  pending,
  first,
  blocked = null,
  reasonId,
}: {
  projectId: string;
  fixId: string;
  pending: boolean;
  first: boolean;
  blocked?: string | null;
  reasonId?: string;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const run = () =>
    startTransition(async () => {
      const outcome = await settle(() => runFixSimulationAction(projectId, fixId));
      if (!outcome.ok) {
        toast({
          title: "Couldn't start the simulation",
          description: outcome.message,
          tone: "danger",
        });
        return;
      }
      toast({
        title: "Simulation started",
        description:
          "Your past runs are replayed with the fix applied. Your live agent isn't touched.",
      });
      router.refresh();
    });
  return (
    <Button
      variant="primary"
      loading={busy || pending}
      disabled={!!blocked}
      focusableWhenDisabled={!!blocked || busy || pending}
      aria-describedby={blocked ? reasonId : undefined}
      onClick={run}
    >
      {pending ? "Simulating…" : busy ? "Starting…" : first ? "Run simulation" : "Run again"}
    </Button>
  );
}

export function PickRunsButton({ projectId, fixId }: { projectId: string; fixId: string }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const pick = () =>
    startTransition(async () => {
      const outcome = await settle(() => createEvalSetAction(projectId, fixId));
      if (!outcome.ok) {
        toast({ title: "Couldn't pick the runs", description: outcome.message, tone: "danger" });
        return;
      }
      router.refresh();
    });
  return (
    <Button variant="ghost" loading={busy} onClick={pick}>
      {busy ? "Picking runs…" : "Pick runs first"}
    </Button>
  );
}

/** One side of a run: pass or fail as a dot and a word, and what the scored checks read; how it was simulated under "after". */
function SideCell({
  side,
  skipped,
  note,
  method,
}: {
  side: SideResult | null | undefined;
  skipped: string | null;
  note?: string | null;
  method?: string | null;
}) {
  if (skipped) {
    return (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs text-fg-subtle">{skipped}</span>
        {note ? (
          <span className="text-xs text-fg-faint" title={note}>
            {note}
          </span>
        ) : null}
      </span>
    );
  }
  if (!side) return <span className="text-fg-faint">Not simulated</span>;
  const scored = side.checks.filter((check) => check.measured !== false);
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <StatusDot tone={side.pass ? "success" : "danger"} label={side.pass ? "Passes" : "Fails"} />
      <span
        className="truncate text-xs text-fg-subtle tabular-nums"
        title={side.checks
          .map((check) => `${CHECK_LABELS[check.kind]}: ${check.detail}`)
          .join("\n")}
      >
        {scored.map((check) => check.detail).join(" · ")}
      </span>
      {method ? (
        <span className="truncate text-xs text-fg-faint" title={note ?? undefined}>
          {method}
          {note ? ` · ${note}` : ""}
        </span>
      ) : null}
    </span>
  );
}

export function EvalRuns({ model }: { model: EvalGatePageModel }) {
  const router = useRouter();
  const [editing, setEditing] = useState<EvalCaseRow | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [adding, startAdding] = useTransition();
  const [topping, startTopping] = useTransition();
  const [runId, setRunId] = useState("");
  const rows = model.cases.filter((row) => !hidden.has(row.id));
  const names = new Map(model.tools.map((tool) => [tool.id, tool.name]));

  const hide = (id: string, on: boolean) =>
    setHidden((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Removed at once; Undo puts the run back (with a freshly drafted expected outcome). */
  const remove = (row: EvalCaseRow) => {
    hide(row.id, true);
    void settle(() => removeEvalCaseAction(model.projectId, model.fixId, row.id)).then(
      (outcome) => {
        if (!outcome.ok) {
          hide(row.id, false);
          toast({ title: "Couldn't remove the run", description: outcome.message, tone: "danger" });
          return;
        }
        toast({
          title: "Run removed",
          description: "Run the simulation again to update the numbers.",
          action: {
            label: "Undo",
            onClick: () => {
              void settle(() => addEvalRunAction(model.projectId, model.fixId, row.turnId)).then(
                (undone) => {
                  if (!undone.ok)
                    toast({
                      title: "Couldn't put the run back",
                      description: undone.message,
                      tone: "danger",
                    });
                  router.refresh();
                },
              );
            },
          },
        });
        router.refresh();
      },
    );
  };

  const addRun = (event: FormEvent) => {
    event.preventDefault();
    const value = runId.trim();
    if (!value) return;
    startAdding(async () => {
      const outcome = await settle(() => addEvalRunAction(model.projectId, model.fixId, value));
      if (!outcome.ok) {
        toast({ title: "Couldn't add the run", description: outcome.message, tone: "danger" });
        return;
      }
      setRunId("");
      toast({ title: outcome.message ?? "Run added" });
      router.refresh();
    });
  };

  const topUp = () =>
    startTopping(async () => {
      const outcome = await settle(() => addRunsFromHistoryAction(model.projectId, model.fixId));
      if (!outcome.ok) {
        toast({ title: "Couldn't add runs", description: outcome.message, tone: "danger" });
        return;
      }
      toast({ title: outcome.message ?? "Runs added" });
      router.refresh();
    });

  const columns: readonly Column<EvalCaseRow>[] = [
    {
      id: "run",
      header: "Run",
      className: "min-w-44",
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <Link
            href={row.runHref}
            className="truncate rounded-md font-mono text-xs text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
            title={row.turnId}
          >
            {row.turnId.slice(0, 8)}…{row.turnId.slice(-4)}
          </Link>
          <span className="text-xs text-fg-subtle">
            {row.originLabel}
            {row.role === "evidence" ? " · not counted" : ""}
          </span>
        </span>
      ),
    },
    {
      id: "expected",
      header: "Expected outcome",
      className: "w-full max-w-0",
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-ui text-fg">{row.outcome || row.expectedText}</span>
          <span className="truncate text-xs text-fg-subtle">
            {row.outcome ? row.expectedText : row.criteria || "Checks drafted from the run"}
          </span>
        </span>
      ),
    },
    {
      id: "before",
      header: "Before",
      className: "min-w-40",
      hiddenBelow: "sm",
      cell: (row) => <SideCell side={row.result?.before} skipped={row.skippedLabel} />,
    },
    {
      id: "after",
      header: "After the fix",
      className: "min-w-40",
      cell: (row) => (
        <SideCell
          side={row.result?.after}
          skipped={row.skippedLabel ? (row.methodNote ? "Can't simulate" : "Skipped") : null}
          note={row.methodNote}
          method={row.result?.method === "replay" ? row.methodLabel : null}
        />
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      className: "min-w-20",
      cell: (row) => (
        <span className="flex justify-end gap-1">
          <IconButton
            label="Edit the expected outcome"
            icon={<Pencil />}
            size="icon-sm"
            variant="ghost"
            onClick={() => setEditing(row)}
          />
          <IconButton
            label="Remove the run"
            icon={<Trash2 />}
            size="icon-sm"
            variant="ghost"
            onClick={() => remove(row)}
          />
        </span>
      ),
    },
  ];

  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          Runs
          <span className="font-normal text-fg-subtle tabular-nums">{rows.length}</span>
        </span>
      }
      description="Past runs from your traces, each with what it should do once the fix is made."
      actions={
        <>
          <form onSubmit={addRun} className="flex items-center gap-2">
            <Input
              aria-label="Run or trace id"
              placeholder="Run or trace id"
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
              className="w-56 font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              loading={adding}
              disabled={!runId.trim()}
            >
              {adding ? "Adding…" : "Add run"}
            </Button>
          </form>
          {model.fix ? (
            <Button variant="ghost" size="sm" loading={topping} onClick={topUp}>
              {topping ? "Adding runs…" : "Add runs from history"}
            </Button>
          ) : null}
        </>
      }
    >
      <DataTable
        caption="The eval's runs"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        onRowOpen={(row) => setEditing(row)}
        empty={
          <EmptyState
            title="No runs in this eval"
            description="Add runs from your traces, or paste a run or trace id."
            action={
              model.fix ? (
                <Button variant="secondary" loading={topping} onClick={topUp}>
                  Add runs from history
                </Button>
              ) : undefined
            }
          />
        }
      />
      <Dialog open={editing !== null} onOpenChange={(open) => (open ? null : setEditing(null))}>
        {editing ? (
          <EditCase
            key={editing.id}
            model={model}
            row={editing}
            names={names}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Dialog>
    </Section>
  );
}

const NONE = "none";

function decimalOrNull(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function numberOrNull(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** A run's expected outcome: the tool it should find, its limits, and the outcome and criteria in words. */
function EditCase({
  model,
  row,
  names,
  onDone,
}: {
  model: EvalGatePageModel;
  row: EvalCaseRow;
  names: ReadonlyMap<string, string>;
  onDone: () => void;
}) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [tool, setTool] = useState(row.expected.tool ?? NONE);
  const [calls, setCalls] = useState(row.expected.maxToolCalls?.toString() ?? "");
  const [searches, setSearches] = useState(row.expected.maxSearches?.toString() ?? "");
  const [failed, setFailed] = useState(row.expected.maxFailedCalls?.toString() ?? "");
  const [endsWell, setEndsWell] = useState(row.expected.endsWell === true);
  const [corrections, setCorrections] = useState(row.expected.maxSelfCorrections?.toString() ?? "");
  const [cost, setCost] = useState(row.expected.maxCostUsd?.toString() ?? "");
  const [seconds, setSeconds] = useState(
    row.expected.maxLatencyMs != null ? String(row.expected.maxLatencyMs / 1000) : "",
  );
  const [outcome, setOutcome] = useState(row.outcome);
  const [criteria, setCriteria] = useState(row.criteria);
  const options = [
    { value: NONE, label: "No check" },
    ...model.tools.map((item) => ({ value: item.id, label: item.name })),
  ];
  if (row.expected.tool && !names.has(row.expected.tool))
    options.push({ value: row.expected.tool, label: row.expected.tool });

  const save = (event?: FormEvent) => {
    event?.preventDefault();
    startSaving(async () => {
      const result = await settle(() =>
        updateEvalCaseAction(model.projectId, model.fixId, row.id, {
          tool: tool === NONE ? null : tool,
          maxToolCalls: numberOrNull(calls),
          maxSearches: numberOrNull(searches),
          maxFailedCalls: numberOrNull(failed),
          avoidTools: row.expected.avoidTools,
          endsWell: endsWell ? true : null,
          maxSelfCorrections: numberOrNull(corrections),
          maxCostUsd: decimalOrNull(cost),
          maxLatencyMs:
            decimalOrNull(seconds) === null ? null : Math.round(decimalOrNull(seconds)! * 1000),
          outcome,
          criteria,
        }),
      );
      if (!result.ok) {
        toast({
          title: "Couldn't save the expected outcome",
          description: result.message,
          tone: "danger",
        });
        return;
      }
      toast({
        title: "Expected outcome saved",
        description: "Run the simulation again to update the numbers.",
      });
      onDone();
      router.refresh();
    });
  };

  return (
    <DialogContent
      title="Expected outcome"
      description={`What run ${row.turnId.slice(0, 8)} should do once the fix is made. Empty limits are not checked.`}
      footer={
        <>
          <DialogClose render={<Button variant="secondary">Cancel</Button>} />
          <Button variant="primary" loading={saving} onClick={() => save()}>
            {saving ? "Saving…" : "Save expected outcome"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={save}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
        }}
        className="flex flex-col gap-4"
      >
        <Field label={CHECK_LABELS.right_tool} description="The tool the first search should list.">
          {(control) => (
            <Select
              {...control}
              aria-label={CHECK_LABELS.right_tool}
              options={options}
              value={tool}
              onValueChange={setTool}
              className="w-full"
            />
          )}
        </Field>
        <fieldset className="grid grid-cols-3 gap-3">
          <legend className="mb-1.5 text-xs font-medium text-fg-muted">At most</legend>
          <Field label={CHECK_LABELS.max_tool_calls}>
            {(control) => (
              <Input
                {...control}
                type="number"
                inputMode="numeric"
                min={0}
                value={calls}
                onChange={(event) => setCalls(event.target.value)}
              />
            )}
          </Field>
          <Field label={CHECK_LABELS.max_searches}>
            {(control) => (
              <Input
                {...control}
                type="number"
                inputMode="numeric"
                min={0}
                value={searches}
                onChange={(event) => setSearches(event.target.value)}
              />
            )}
          </Field>
          <Field label={CHECK_LABELS.max_failed_calls}>
            {(control) => (
              <Input
                {...control}
                type="number"
                inputMode="numeric"
                min={0}
                value={failed}
                onChange={(event) => setFailed(event.target.value)}
              />
            )}
          </Field>
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1.5 text-xs font-medium text-fg-muted">How the run ends</legend>
          <Checkbox
            label={CHECK_LABELS.ends_well}
            checked={endsWell}
            onCheckedChange={setEndsWell}
          />
          <p className="text-xs text-fg-subtle">{FINISHES_CLEANLY_HELP}</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label={CHECK_LABELS.max_self_corrections}>
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={corrections}
                  onChange={(event) => setCorrections(event.target.value)}
                />
              )}
            </Field>
            <Field label={`${CHECK_LABELS.max_cost} ($)`}>
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.0001"
                  value={cost}
                  onChange={(event) => setCost(event.target.value)}
                />
              )}
            </Field>
            <Field label={`${CHECK_LABELS.max_latency} (s)`}>
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.1"
                  value={seconds}
                  onChange={(event) => setSeconds(event.target.value)}
                />
              )}
            </Field>
          </div>
        </fieldset>
        <Field
          label="Expected outcome"
          description="In your words, shown on the run's row. Judged by a model when one is configured."
        >
          {(control) => (
            <Input
              {...control}
              value={outcome}
              maxLength={2000}
              placeholder="Finds the order and answers in one call"
              onChange={(event) => setOutcome(event.target.value)}
            />
          )}
        </Field>
        <Field label="Criteria" description="What a reviewer should check. ⌘Enter saves.">
          {(control) => (
            <Textarea
              {...control}
              value={criteria}
              maxLength={2000}
              onChange={(event) => setCriteria(event.target.value)}
            />
          )}
        </Field>
        {row.expected.avoidTools.length > 0 ? (
          <p className="text-xs text-fg-subtle">
            {CHECK_LABELS.avoid_tools}:{" "}
            {row.expected.avoidTools.map((id) => names.get(id) ?? id).join(", ")}
          </p>
        ) : null}
      </form>
    </DialogContent>
  );
}
