"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Field, Input } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { ListChecks } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatInteger, formatMoney } from "@/lib/synthesis/traces/v2/format";
import type { UseCaseStats } from "@/lib/views/fine-tuning/domain/stats";
import type { UseCaseSelector } from "@/lib/views/fine-tuning/domain/use-case";

export interface UseCaseRowView {
  id: string;
  name: string;
  selector: UseCaseSelector;
  createdAt: string;
  /** Null when the stats could not be read. */
  stats: UseCaseStats | null;
}

/**
 * A project's fine-tuning use cases (RC-1124): the list, and a form that
 * names one task's model calls, optionally of one model. Each create is one
 * `POST` to the use cases route; the page re-reads after it.
 */
export function UseCasesPanel({
  apiHref,
  useCases,
  taskOptions,
  taskNames,
}: {
  apiHref: string;
  useCases: readonly UseCaseRowView[];
  /** The project's tasks with closed runs in the last 30 days, busiest first. */
  taskOptions: readonly { taskId: string; turns: number }[];
  /** The Tasks page's names, by task id; a task with none shows its id. */
  taskNames: Readonly<Record<string, string>>;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [taskId, setTaskId] = useState<string>(taskOptions[0]?.taskId ?? "");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    setError(null);
    const selector = {
      taskIds: [taskId],
      ...(model.trim() ? { callFilter: { models: [model.trim()] } } : {}),
    };
    startTransition(async () => {
      const response = await fetch(apiHref, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, selector }),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
      } | null;
      if (!response.ok || !result?.ok) {
        setError(result?.message ?? "The use case was not saved. Try again.");
        return;
      }
      setName("");
      setModel("");
      router.refresh();
    });
  }

  const columns: Column<UseCaseRowView>[] = [
    {
      id: "name",
      header: "Use case",
      cell: (row) => <span className="font-medium text-fg">{row.name}</span>,
    },
    {
      id: "selects",
      header: "Selects",
      hiddenBelow: "lg",
      cell: (row) => selectorSummary(row.selector, taskNames),
    },
    {
      id: "runs",
      header: "Runs",
      align: "right",
      width: "6rem",
      cell: (row) =>
        row.stats ? `${row.stats.sampled ? "≥" : ""}${formatInteger(row.stats.turns)}` : "—",
    },
    {
      id: "calls",
      header: "Model calls",
      align: "right",
      width: "7rem",
      cell: (row) => (row.stats ? formatInteger(row.stats.calls) : "—"),
    },
    {
      id: "dates",
      header: "Runs from",
      width: "12rem",
      hiddenBelow: "md",
      cell: (row) => dateRange(row.stats),
    },
    {
      id: "model",
      header: "Current model",
      width: "11rem",
      cell: (row) => row.stats?.currentModel ?? "—",
    },
    {
      id: "cost",
      header: "Cost per run",
      align: "right",
      width: "8rem",
      cell: (row) => costCell(row.stats),
    },
  ];

  return (
    <Section
      title="Use cases"
      description="A use case names the model calls of one job. A dataset is built from it."
    >
      <DataTable
        caption="Use cases"
        columns={columns}
        rows={useCases}
        rowKey={(row) => row.id}
        empty={
          <EmptyState
            icon={ListChecks}
            title="No use cases yet"
            description="Pick a task below to name its model calls."
          />
        }
      />
      {taskOptions.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No tasks to pick"
          description="A use case selects the runs of a task. Tasks show up once this project has closed runs in the last 30 days."
        />
      ) : (
        <form
          className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-raised p-4"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <Field label="Name" className="min-w-48 flex-1">
            {(control) => (
              <Input
                {...control}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ticket triage"
                maxLength={80}
              />
            )}
          </Field>
          <Field label="Task" className="min-w-48 flex-1">
            {(control) => (
              <Select
                id={control.id}
                aria-label="Task"
                value={taskId}
                onValueChange={setTaskId}
                options={taskOptions.map((task) => ({
                  value: task.taskId,
                  label: `${taskNames[task.taskId] ?? task.taskId} (${task.turns} runs)`,
                }))}
              />
            )}
          </Field>
          <Field label="Only this model (optional)" className="min-w-48 flex-1">
            {(control) => (
              <Input
                {...control}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Any model"
              />
            )}
          </Field>
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            disabled={!name.trim() || !taskId}
          >
            Create use case
          </Button>
        </form>
      )}
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Section>
  );
}

function dateRange(stats: UseCaseStats | null): string {
  if (!stats?.firstEndedAt || !stats.lastEndedAt) return "—";
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day(stats.firstEndedAt)} – ${day(stats.lastEndedAt)}`;
}

/** Unpriced calls are never $0: with no priced run the cell says Unpriced. */
function costCell(stats: UseCaseStats | null) {
  if (!stats || stats.calls === 0) return "—";
  if (stats.costPerRunUsd === null) return <Badge tone="warning">Unpriced</Badge>;
  return (
    <span
      title={stats.unpricedCalls > 0 ? `${stats.unpricedCalls} unpriced calls left out` : undefined}
    >
      {formatMoney(stats.costPerRunUsd)}
      {stats.unpricedCalls > 0 ? " *" : ""}
    </span>
  );
}

function selectorSummary(
  selector: UseCaseSelector,
  taskNames: Readonly<Record<string, string>>,
): string {
  const parts = [
    ...(selector.taskIds.length
      ? [
          `${selector.taskIds.length === 1 ? "Task" : "Tasks"} ${selector.taskIds.map((id) => taskNames[id] ?? id).join(", ")}`,
        ]
      : []),
    ...(selector.intentIds.length
      ? [`${selector.intentIds.length} ${selector.intentIds.length === 1 ? "intent" : "intents"}`]
      : []),
    ...(selector.callFilter?.models?.length
      ? [`model ${selector.callFilter.models.join(", ")}`]
      : []),
    ...(selector.callFilter?.spanNames?.length
      ? [`span ${selector.callFilter.spanNames.join(", ")}`]
      : []),
  ];
  return parts.join(" · ");
}
