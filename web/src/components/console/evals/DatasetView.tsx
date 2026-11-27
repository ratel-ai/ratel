"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { CodeBlock } from "@ratel/design-system/code";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { ConfirmDialog, Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { toast } from "@ratel/design-system/toast";
import { Rows3 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { PickerOptions } from "@/lib/views/evals/adapters/turn-picker";
import { type DatasetPage, type DatasetPageRow, shortText } from "@/lib/views/evals/dataset-pages";
import { datasetsHref } from "@/lib/views/evals/paths";
import { QueryPreview, TurnPicker } from "./DatasetPickers";

/**
 * One dataset. A fixed one shows its rows, each trace row with a link to its trace, and adds and
 * removes rows. A query kind shows its query and what it resolves now: a run freezes its rows.
 */
export function DatasetView({
  model,
  options,
  canEdit,
  now,
}: {
  model: DatasetPage;
  options: PickerOptions;
  canEdit: boolean;
  now: string;
}) {
  return (
    <Page>
      <PageHeader
        crumbs={[{ label: "Datasets", href: datasetsHref(model.projectId) }]}
        title={model.name}
        description={model.description ?? undefined}
        actions={
          model.fixed && canEdit ? (
            <AddRowsDialog
              projectId={model.projectId}
              datasetId={model.datasetId}
              options={options}
              now={now}
            />
          ) : null
        }
      />
      <PageBody>
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-ui">
          <Fact label="Kind">
            <Badge tone={model.fixed ? "neutral" : "info"}>{model.kindLabel}</Badge>
          </Fact>
          {model.fixed ? (
            <Fact label="Cases">
              <span className="tabular-nums">{model.rows.length}</span>
            </Fact>
          ) : null}
          <Fact label="Updated">
            <span title={model.updatedAt}>{formatRelativeTime(model.updatedAt, now)}</span>
          </Fact>
          <Fact label="Used by">
            {model.usedBy.length === 0 ? (
              <span className="text-fg-faint">No eval</span>
            ) : (
              model.usedBy.map((used) => (
                <Link key={used.evalId} href={used.href} className="hover:underline">
                  {used.name}
                </Link>
              ))
            )}
          </Fact>
        </dl>
        {model.fixed ? (
          <FixedRows model={model} canEdit={canEdit} />
        ) : (
          <QuerySection model={model} />
        )}
      </PageBody>
    </Page>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="flex items-center gap-2 text-fg">{children}</dd>
    </div>
  );
}

function FixedRows({
  model,
  canEdit,
}: {
  model: Extract<DatasetPage, { fixed: true }>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [removing, setRemoving] = useState<DatasetPageRow | null>(null);

  async function remove(row: DatasetPageRow) {
    const response = await fetch(
      `/api/projects/${model.projectId}/evals/datasets/${model.datasetId}/rows/${row.rowId}`,
      { method: "DELETE" },
    );
    if (!response.ok) throw new Error("not removed");
    setRemoving(null);
    toast({ title: `Row ${row.name} removed`, tone: "success" });
    router.refresh();
  }

  const columns: Column<DatasetPageRow>[] = [
    {
      id: "input",
      header: "Input",
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-fg" title={row.input}>
            {shortText(row.input)}
          </span>
          <span className="truncate text-xs text-fg-subtle">{row.name}</span>
        </span>
      ),
    },
    {
      id: "expected",
      header: "Expected output",
      width: "28%",
      hiddenBelow: "md",
      cell: (row) =>
        row.expectedOutput ? (
          <span className="block truncate text-fg-muted" title={row.expectedOutput}>
            {shortText(row.expectedOutput)}
          </span>
        ) : (
          <span className="text-fg-faint">None</span>
        ),
    },
    {
      id: "source",
      header: "Source",
      width: "8rem",
      cell: (row) =>
        row.turnHref ? (
          <Link href={row.turnHref} className="text-fg-muted hover:text-fg hover:underline">
            Trace
          </Link>
        ) : (
          <span className="text-fg-subtle">No trace</span>
        ),
    },
    ...(canEdit
      ? [
          {
            id: "remove",
            header: <span className="sr-only">Remove</span>,
            width: "6rem",
            align: "right" as const,
            cell: (row: DatasetPageRow) => (
              <Button size="sm" variant="ghost" onClick={() => setRemoving(row)}>
                Remove
              </Button>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <DataTable
        caption="Rows"
        columns={columns}
        rows={model.rows}
        rowKey={(row) => row.rowId}
        empty={
          <EmptyState
            icon={Rows3}
            title="No row yet"
            description="Add rows from traces or type them. Save as eval case on a trace also adds a row here."
          />
        }
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? null : setRemoving(null))}
        title={`Remove ${removing?.name ?? "the row"}?`}
        description="New runs do not use it. Runs that used it keep it."
        confirmLabel="Remove row"
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </>
  );
}

function QuerySection({ model }: { model: Extract<DatasetPage, { fixed: false }> }) {
  return (
    <>
      <Section title="Query">
        {model.querySettings.kind === "rql" ? (
          <CodeBlock caption="RQL" samples={[{ label: "RQL", code: model.querySettings.text }]} />
        ) : (
          <p className="text-ui text-fg">{model.query}</p>
        )}
      </Section>
      <Callout title="A run freezes the rows">{model.freezeNote}</Callout>
      <Section title="What it resolves now">
        <QueryPreview projectId={model.projectId} query={model.querySettings} auto />
      </Section>
    </>
  );
}

/** Adds rows to a fixed dataset: traces that a person chooses, or one typed row. */
function AddRowsDialog({
  projectId,
  datasetId,
  options,
  now,
}: {
  projectId: string;
  datasetId: string;
  options: PickerOptions;
  now: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<"traces" | "typed">("traces");
  const [turnIds, setTurnIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [input, setInput] = useState("");
  const [expected, setExpected] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ready = from === "traces" ? turnIds.length > 0 : Boolean(name.trim() && input.trim());

  function reset(next: boolean) {
    setOpen(next);
    if (next) return;
    setTurnIds([]);
    setName("");
    setInput("");
    setExpected("");
    setProblem(null);
  }

  async function add() {
    setSaving(true);
    setProblem(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/evals/datasets/${datasetId}/rows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          from === "traces"
            ? { turnIds }
            : { row: { name, input, expectedOutput: expected.trim() || null } },
        ),
      });
      const body = (await response.json().catch(() => ({}))) as {
        rows?: unknown[];
        message?: string;
      };
      if (!response.ok) return setProblem(body.message ?? "Try again.");
      const count = body.rows?.length ?? 0;
      toast({ title: count === 1 ? "1 row added" : `${count} rows added`, tone: "success" });
      reset(false);
      router.refresh();
    } catch {
      setProblem("Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Add rows
      </Button>
      <Dialog open={open} onOpenChange={reset}>
        <DialogContent
          title="Add rows"
          description="Each row counts in the next run at once."
          className="max-w-2xl"
          footer={
            <>
              <DialogClose render={<Button />}>Cancel</DialogClose>
              <Button variant="primary" onClick={add} disabled={saving || !ready}>
                {saving ? "Adding…" : "Add"}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <SegmentedControl
              label="Rows from"
              value={from}
              onValueChange={setFrom}
              options={[
                { value: "traces", label: "From traces" },
                { value: "typed", label: "Typed values" },
              ]}
            />
            {from === "traces" ? (
              <TurnPicker
                projectId={projectId}
                turns={options.turns}
                chosen={turnIds}
                onChange={setTurnIds}
                now={now}
              />
            ) : (
              <>
                <Field label="Name">
                  {(control) => (
                    <Input
                      {...control}
                      value={name}
                      maxLength={200}
                      onChange={(event) => setName(event.currentTarget.value)}
                    />
                  )}
                </Field>
                <Field label="Input">
                  {(control) => (
                    <Textarea
                      {...control}
                      rows={3}
                      value={input}
                      onChange={(event) => setInput(event.currentTarget.value)}
                    />
                  )}
                </Field>
                <Field label="Expected output" description="Optional.">
                  {(control) => (
                    <Textarea
                      {...control}
                      rows={2}
                      value={expected}
                      onChange={(event) => setExpected(event.currentTarget.value)}
                    />
                  )}
                </Field>
              </>
            )}
            {problem ? (
              <Callout tone="danger" title="No row was added">
                {problem}
              </Callout>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
