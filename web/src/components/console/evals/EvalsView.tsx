"use client";

import { Badge } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { ListChecks } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import {
  type CaseRow,
  caseLabels,
  type ExperimentRow,
  type ReadyVersion,
  runnableCases,
} from "@/lib/views/evals/page-model";
import { caseHref } from "@/lib/views/evals/paths";
import { ExperimentList } from "./ExperimentList";
import { RunEvals } from "./RunEvals";

/** The experiments and the cases of a project. */
export function EvalsView({
  projectId,
  canEdit,
  cases,
  experiments,
  baselineId,
  versions,
  now,
  children,
}: {
  projectId: string;
  canEdit: boolean;
  cases: CaseRow[];
  experiments: ExperimentRow[];
  baselineId: string | null;
  versions: ReadyVersion[];
  /** ISO time the page was rendered, so relative times agree on server and client. */
  now: string;
  /** What the edition adds at the foot. */
  children?: ReactNode;
}) {
  const router = useRouter();
  const labels = caseLabels(cases);
  const [label, setLabel] = useState<string | null>(null);
  const shown = label === null ? cases : cases.filter((row) => row.labels.includes(label));
  return (
    <Page>
      <PageHeader
        title="Evals"
        description="A case is one input for your agent and the checks of its answer. An approved case does not change."
        actions={
          canEdit ? (
            <Link
              href={caseHref(projectId, "new")}
              className={buttonVariants({ variant: "secondary" })}
            >
              New case
            </Link>
          ) : null
        }
      />
      <PageBody>
        {canEdit ? (
          <RunEvals
            projectId={projectId}
            versions={versions}
            labels={labels}
            label={label}
            onLabelChange={setLabel}
            cases={runnableCases(cases, label)}
          />
        ) : null}
        <ExperimentList
          projectId={projectId}
          experiments={experiments}
          baselineId={baselineId}
          now={now}
        />
        <Section
          title="Cases"
          description="Only an approved case counts in an eval run. Open a case to read its full input and expected output."
          actions={
            labels.length > 0 ? (
              <LabelFilter labels={labels} label={label} onChange={setLabel} />
            ) : null
          }
        >
          {cases.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="No case yet"
              description="Open a turn in Traces and save it as an eval case, or make a new one."
            />
          ) : (
            <DataTable
              caption="Eval cases"
              columns={caseColumns(projectId, now)}
              rows={shown}
              rowKey={(row) => row.id}
              onRowOpen={(row) => router.push(caseHref(projectId, row.id))}
              className="[&_table]:table-fixed"
            />
          )}
        </Section>
        {children}
      </PageBody>
    </Page>
  );
}

function LabelFilter({
  labels,
  label,
  onChange,
}: {
  labels: string[];
  label: string | null;
  onChange: (label: string | null) => void;
}) {
  const chip = (name: string | null, text: string) => (
    <button
      key={name ?? ""}
      type="button"
      aria-pressed={label === name}
      onClick={() => onChange(name)}
      className="rounded-md border border-line px-2 py-0.5 text-xs text-fg-muted hover:bg-hover aria-pressed:border-accent aria-pressed:bg-selected aria-pressed:text-fg"
    >
      {text}
    </button>
  );
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5">
      <legend className="sr-only">Label</legend>
      {chip(null, "All")}
      {labels.map((name) => chip(name, name))}
    </fieldset>
  );
}

function caseColumns(projectId: string, now: string): Column<CaseRow>[] {
  return [
    {
      id: "name",
      header: "Case",
      width: "16%",
      cell: (row) => (
        <Link
          href={caseHref(projectId, row.id)}
          className="block truncate font-medium text-fg underline-offset-2 hover:underline"
        >
          {row.name}
        </Link>
      ),
    },
    {
      id: "input",
      header: "Input",
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <code className="truncate font-mono text-xs text-fg" title={row.input}>
            {row.input}
          </code>
          {row.turns > 0 ? (
            <span className="shrink-0 text-xs text-fg-subtle">+{row.turns} turns</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "expected",
      header: "Expected output",
      width: "26%",
      cell: (row) =>
        row.expectedOutput === null ? (
          <span className="text-xs text-fg-faint">None</span>
        ) : (
          <span className="block truncate text-fg-muted" title={row.expectedOutput}>
            {row.expectedOutput}
          </span>
        ),
    },
    {
      id: "labels",
      header: "Labels",
      width: "9rem",
      hiddenBelow: "md",
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.labels.map((name) => (
            <Badge key={name} tone="neutral">
              {name}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "8.5rem",
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.approved !== null ? <Badge tone="success">Approved v{row.approved}</Badge> : null}
          {row.draft !== null ? <Badge tone="neutral">Draft v{row.draft}</Badge> : null}
        </span>
      ),
    },
    {
      id: "created",
      header: "Created",
      width: "6.5rem",
      align: "right",
      hiddenBelow: "lg",
      cell: (row) => (
        <span className="text-xs whitespace-nowrap text-fg-subtle" title={row.createdAt}>
          {formatRelativeTime(row.createdAt, now)}
        </span>
      ),
    },
  ];
}
