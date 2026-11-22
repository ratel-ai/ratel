"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Field, Input } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { Tooltip } from "@ratel/design-system/tooltip";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { TaskEvalActionInput, TaskEvalActionResult } from "@/lib/views/task-evals/actions";
import type { TaskEvalRefresh, TaskEvalRow } from "@/lib/views/task-evals/view";
import { FINISHES_CLEANLY_HELP } from "@/lib/views/task-scorers/labels";
import { changeTaskEvalAction } from "./eval-actions";

export type { TaskEvalRow } from "@/lib/views/task-evals/view";

const GROUPS = [
  { key: "pinned", title: "Pinned" },
  { key: "user", title: "Added by you" },
  { key: "auto", title: "Automatic" },
  { key: "issue", title: "Issue evidence" },
  { key: "excluded", title: "Excluded" },
] as const;

export function Evals({
  projectId,
  taskId,
  rows,
  targetRuns,
  refreshedAt,
  refreshJob = null,
}: {
  projectId: string;
  taskId: string;
  rows: readonly TaskEvalRow[];
  targetRuns: number;
  refreshedAt: string | null;
  refreshJob?: TaskEvalRefresh | null;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const expanded = new Set(search.get("evalGroups")?.split(",") ?? []);
  const [runId, setRunId] = useState("");
  const [result, setResult] = useState<TaskEvalActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const activeRows = rows.filter((row) => !row.excluded);
  const preserved = activeRows.filter((row) => row.pinned || row.origin === "user").length;
  const requestedJobId = result?.ok ? result.jobId : undefined;
  const refreshing =
    Boolean(requestedJobId && refreshJob?.id !== requestedJobId) ||
    refreshJob?.status === "queued" ||
    refreshJob?.status === "running";
  const busy = pending || refreshing;
  const refreshFailed = !refreshing && refreshJob?.status === "error";

  useEffect(() => {
    if (!refreshing) return;
    const timer = window.setInterval(() => router.refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refreshing, router]);

  function commit(command: TaskEvalActionInput) {
    setResult(null);
    startTransition(async () => {
      const next = await changeTaskEvalAction(command);
      setResult(next);
      if (next.ok) {
        if (command.action === "add") setRunId("");
        router.refresh();
      }
    });
  }

  function toggleGroup(key: string) {
    const url = new URL(window.location.href);
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    if (expanded.size > 0) url.searchParams.set("evalGroups", [...expanded].join(","));
    else url.searchParams.delete("evalGroups");
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  }

  const columns: Column<TaskEvalRow>[] = [
    {
      id: "ask",
      header: "User's ask",
      width: "32%",
      cell: (row) => (
        <Tooltip
          content={
            <span className="block max-w-lg whitespace-pre-wrap">
              {row.ask}
              <br />
              Run {row.turnId.slice(0, 8)}…{row.turnId.slice(-4)}
            </span>
          }
        >
          <span className="block">
            {row.name ? (
              <span className="mb-1 block truncate text-xs font-medium text-fg">{row.name}</span>
            ) : null}
            <span
              tabIndex={0}
              className="block max-w-[28rem] truncate rounded-md text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {row.ask}
            </span>
          </span>
        </Tooltip>
      ),
    },
    {
      id: "scorers",
      header: "Scorers",
      cell: (row) => (
        <div className="flex flex-wrap gap-1 py-2">
          {row.chips.map((chip) => (
            <Tooltip
              key={chip.kind}
              content={chip.kind === "ends_well" ? FINISHES_CLEANLY_HELP : chip.detail}
            >
              <span
                tabIndex={0}
                className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Badge
                  tone={
                    chip.status === "pass"
                      ? "success"
                      : chip.status === "fail"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {chip.label}:{" "}
                  {chip.status === "pass"
                    ? "Pass"
                    : chip.status === "fail"
                      ? "Fail"
                      : "Not measured"}
                </Badge>
              </span>
            </Tooltip>
          ))}
        </div>
      ),
    },
    {
      id: "reason",
      header: "Selection reason",
      width: "22%",
      cell: (row) =>
        row.issueHref ? (
          <Link
            href={row.issueHref}
            className="rounded-md text-fg-muted outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {row.selectionReason}
          </Link>
        ) : (
          <span className="text-fg-muted">{row.selectionReason}</span>
        ),
    },
    {
      id: "actions",
      header: "Actions",
      width: "14rem",
      cell: (row) => (
        <div className="flex items-center justify-end gap-1 py-1">
          <Link
            href={row.runHref}
            className="mr-2 whitespace-nowrap rounded-md text-xs text-fg-muted outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            Open run
          </Link>
          {row.excluded ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => commit({ projectId, taskId, action: "add", runId: row.turnId })}
            >
              Restore
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  commit({
                    projectId,
                    taskId,
                    action: row.pinned ? "unpin" : "pin",
                    caseId: row.id,
                  })
                }
              >
                {row.pinned ? "Unpin" : "Pin"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => commit({ projectId, taskId, action: "exclude", caseId: row.id })}
              >
                Exclude
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <Section
      title="Evals"
      description="Real runs selected to test changes, with passing and failing examples plus issue evidence."
      actions={
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => commit({ projectId, taskId, action: "refresh" })}
        >
          {refreshing ? "Refreshing…" : "Refresh eval set"}
        </Button>
      }
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-subtle" aria-live="polite">
        <span className="tabular-nums">
          {activeRows.length} runs · target {targetRuns}
        </span>
        {activeRows.length > targetRuns ? (
          <span>{preserved} pinned or added runs are kept beyond the target.</span>
        ) : null}
        <span>{refreshedAt ? `Last refreshed ${refreshedAt.slice(0, 10)}` : "No refresh yet"}</span>
      </div>
      <form
        aria-label="Add an eval run"
        onSubmit={(event) => {
          event.preventDefault();
          commit({ projectId, taskId, action: "add", runId });
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <Field label="Trace ID or turn ID" className="min-w-56 flex-1 max-w-md">
          {(control) => (
            <Input
              {...control}
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
              maxLength={200}
              required
              disabled={busy}
              autoComplete="off"
              placeholder="Paste an ID from this project"
            />
          )}
        </Field>
        <Button type="submit" variant="secondary" size="sm" disabled={busy || !runId.trim()}>
          Add run
        </Button>
      </form>
      {refreshing || result || refreshFailed ? (
        <p
          className={`text-xs ${refreshFailed || (result && !result.ok) ? "text-danger" : "text-fg-muted"}`}
          aria-live="polite"
          role={refreshFailed || (result && !result.ok) ? "alert" : "status"}
        >
          {refreshing
            ? "Refreshing…"
            : refreshFailed
              ? "The refresh failed. Try again."
              : result?.ok
                ? result.jobId
                  ? "Eval set refreshed."
                  : result.message
                : result?.error}
        </p>
      ) : null}
      {activeRows.length === 0 ? (
        <EmptyState
          emblem
          title="No eval runs yet"
          description="Refresh the eval set to select real runs, or add a trace ID or turn ID."
        />
      ) : null}
      {GROUPS.map((group) => {
        const cases = rows.filter((row) =>
          group.key === "excluded"
            ? row.excluded
            : !row.excluded &&
              (group.key === "pinned" ? row.pinned : !row.pinned && row.origin === group.key),
        );
        if (cases.length === 0 && group.key !== "excluded") return null;
        const showAll = expanded.has(group.key);
        return (
          <div key={group.key} className="mt-2 flex flex-col gap-2">
            <h3 className="text-xs font-medium text-fg-muted">
              {group.title} <span className="text-fg-subtle tabular-nums">({cases.length})</span>
            </h3>
            {cases.length > 0 ? (
              <DataTable
                className="[&_table]:table-fixed max-md:[&_table]:min-w-[64rem]"
                caption={`${group.title} eval runs`}
                columns={columns}
                rows={showAll ? cases : cases.slice(0, 5)}
                rowKey={(row) => row.id}
              />
            ) : (
              <p className="text-xs text-fg-subtle">No excluded runs.</p>
            )}
            {cases.length > 5 ? (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                aria-expanded={showAll}
                onClick={() => toggleGroup(group.key)}
              >
                {showAll ? "Show fewer" : `Show all ${cases.length}`}
              </Button>
            ) : null}
          </div>
        );
      })}
    </Section>
  );
}
