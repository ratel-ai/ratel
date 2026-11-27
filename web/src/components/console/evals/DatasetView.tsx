"use client";

import { Badge } from "@ratel/design-system/badge";
import { IconButton } from "@ratel/design-system/button";
import { CodeBlock } from "@ratel/design-system/code";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { Rows3, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { DatasetPageModel, DatasetRowView } from "@/lib/views/evals/datasets-page";
import { datasetsHref } from "@/lib/views/evals/paths";
import { AddRowsDialog } from "./AddRowsDialog";
import { type QueryDraft, QueryPreview } from "./QueryFields";
import { evalsApi, send } from "./request";

/**
 * One dataset. A fixed dataset lists its rows, each trace row with a link to its trace, with "Add
 * rows" and remove. A query kind shows its query and what it reads now: a run reads it again and
 * freezes the rows that it finds.
 */
export function DatasetView({
  model,
  tasks,
  canEdit,
  now,
}: {
  model: DatasetPageModel;
  tasks: ReadonlyArray<{ id: string; name: string }>;
  canEdit: boolean;
  now: string;
}) {
  const fixed = model.query === null;
  return (
    <Page>
      <PageHeader
        title={model.name}
        crumbs={[{ label: "Datasets", href: datasetsHref(model.projectId) }]}
        description={model.description ?? undefined}
        actions={
          <>
            <Badge tone="neutral">{model.kindLabel}</Badge>
            {fixed && canEdit ? (
              <AddRowsDialog
                projectId={model.projectId}
                datasetId={model.datasetId}
                tasks={tasks}
              />
            ) : null}
          </>
        }
      />
      <PageBody wide>
        <UsedBy model={model} />
        {fixed ? <Rows model={model} canEdit={canEdit} now={now} /> : <Query model={model} />}
      </PageBody>
    </Page>
  );
}

function UsedBy({ model }: { model: DatasetPageModel }) {
  return (
    <p className="text-ui text-fg-muted">
      {model.usedBy.length === 0 ? (
        "No eval uses this dataset yet."
      ) : (
        <>
          Used by{" "}
          {model.usedBy.map((one, index) => (
            <span key={one.evalId}>
              {index > 0 ? ", " : ""}
              <Link href={one.href} className="text-fg hover:underline">
                {one.name}
              </Link>
            </span>
          ))}
          .
        </>
      )}
    </p>
  );
}

function Query({ model }: { model: DatasetPageModel }) {
  const query = model.query;
  if (!query) return null;
  const draft: QueryDraft | null = queryDraft(model);
  return (
    <>
      <Callout tone="info" title="A run freezes the rows">
        This dataset is a query. Each run reads it when it starts and keeps the rows that it finds,
        so a later trace does not change a run that started.
      </Callout>
      <Section title="Query" description={query.words}>
        {query.rql ? <CodeBlock samples={[{ label: "RQL", code: query.rql }]} /> : null}
      </Section>
      <Section title="What it reads now" description="The first rows, read now. Nothing is frozen.">
        {draft ? <QueryPreview projectId={model.projectId} draft={draft} /> : null}
      </Section>
    </>
  );
}

function Rows({ model, canEdit, now }: { model: DatasetPageModel; canEdit: boolean; now: string }) {
  const router = useRouter();
  const [removing, setRemoving] = useState<DatasetRowView | null>(null);
  async function remove(row: DatasetRowView) {
    const answer = await send(
      "DELETE",
      `${evalsApi(model.projectId)}/datasets/${model.datasetId}/rows/${row.rowId}`,
    );
    if (!answer.ok) throw new Error(answer.message);
    toast({ title: `"${row.name}" removed. Runs that read it keep their copy.`, tone: "success" });
    setRemoving(null);
    router.refresh();
  }
  const columns: Column<DatasetRowView>[] = [
    {
      id: "name",
      header: "Row",
      width: "14rem",
      cell: (row) => (
        <span className="flex flex-col">
          <span className="truncate font-medium text-fg">{row.name}</span>
          <span className="text-xs text-fg-subtle">
            {row.kind === "trace" ? "Trace" : "Typed values"} · version {row.version}
          </span>
        </span>
      ),
    },
    {
      id: "input",
      header: "Input",
      cell: (row) =>
        row.input === null ? (
          <span className="text-fg-faint">Captured text is off</span>
        ) : (
          <code className="line-clamp-2 font-mono text-xs break-all text-fg-muted">
            {row.input}
          </code>
        ),
    },
    {
      id: "expected",
      header: "Expected output",
      hiddenBelow: "md",
      cell: (row) =>
        row.expectedOutput === null ? (
          <span className="text-fg-faint">None</span>
        ) : (
          <span className="line-clamp-2 text-fg-muted">{row.expectedOutput}</span>
        ),
    },
    {
      id: "trace",
      header: "Trace",
      width: "7rem",
      cell: (row) =>
        row.traceHref ? (
          <Link href={row.traceHref} className="text-accent-mark hover:underline">
            Open trace
          </Link>
        ) : (
          <span className="text-fg-faint">None</span>
        ),
    },
    {
      id: "updated",
      header: "Updated",
      width: "7rem",
      hiddenBelow: "lg",
      cell: (row) => (
        <span className="text-fg-muted" title={row.updatedAt}>
          {formatRelativeTime(row.updatedAt, now)}
        </span>
      ),
    },
    ...(canEdit
      ? [
          {
            id: "remove",
            header: <span className="sr-only">Remove</span>,
            width: "3rem",
            cell: (row: DatasetRowView) => (
              <IconButton
                label={`Remove ${row.name}`}
                size="icon-sm"
                icon={<Trash2 aria-hidden />}
                onClick={() => setRemoving(row)}
              />
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      {model.contentWithheld ? (
        <Callout tone="info">
          The project does not let Ratel read captured text: a trace row shows its link, not its
          input.
        </Callout>
      ) : null}
      <DataTable
        caption={`Rows of ${model.name}`}
        columns={columns}
        rows={model.rows}
        rowKey={(row) => row.rowId}
        empty={
          <EmptyState
            icon={Rows3}
            title="No row yet"
            description="Add rows from traces or typed values, or save a trace as an eval case."
          />
        }
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? null : setRemoving(null))}
        title={`Remove "${removing?.name ?? ""}"?`}
        description="The next runs do not read this row. Runs that read it keep their copy."
        confirmLabel="Remove row"
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </>
  );
}

function queryDraft(model: DatasetPageModel): QueryDraft | null {
  const query = model.query;
  if (!query) return null;
  const limit = String(query.limit);
  switch (model.kind) {
    case "last_traces":
      return { kind: "last_traces", limit };
    case "rql":
      return { kind: "rql", text: query.rql ?? "", limit };
    case "task_traces":
    case "auto":
      return { kind: model.kind, taskId: query.taskId ?? "", limit };
    default:
      return null;
  }
}
