"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { Rows3 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { CloudMessage } from "@/lib/ingest/cloud-schema";
import type { DatasetView } from "@/lib/views/fine-tuning/domain/dataset";
import type { DatasetRowView } from "@/lib/views/fine-tuning/domain/overrides";

type SideFilter = "all" | "train" | "eval";

const SIDE_OPTIONS = [
  { value: "all", label: "Train and eval" },
  { value: "train", label: "Train only" },
  { value: "eval", label: "Eval only" },
] as const;

/**
 * Download a ready version as two JSONL files, or delete it (RC-1131). The
 * downloads are plain links to the export route, so the browser streams them.
 * Rows the format cannot express are left out, and the count says how many.
 */
export function DatasetActions({
  dataset,
  datasetHref,
}: {
  dataset: DatasetView;
  datasetHref: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const skipped = dataset.counts?.exportSkipped;
  const skippedTotal = skipped ? skipped.train + skipped.eval : null;

  async function remove() {
    setBusy(true);
    const response = await fetch(datasetHref, { method: "DELETE" });
    setBusy(false);
    if (!response.ok) throw new Error("The version was not deleted.");
    setOpen(false);
    router.replace("?", { scroll: false });
    router.refresh();
  }

  return (
    <Section
      title="Export"
      description="OpenAI chat fine-tuning format: one JSON example per line, the system text first and the recorded reply last."
    >
      <div className="flex flex-wrap items-center gap-2">
        <a
          className={buttonVariants({ variant: "secondary" })}
          href={`${datasetHref}/export?side=train`}
          download
        >
          Download train JSONL
        </a>
        <a
          className={buttonVariants({ variant: "secondary" })}
          href={`${datasetHref}/export?side=eval`}
          download
        >
          Download eval JSONL
        </a>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete version
        </Button>
      </div>
      {skippedTotal !== null ? (
        <p className="text-ui text-fg-muted">
          {skippedTotal === 0
            ? "Every row is in the export."
            : `${skippedTotal} ${skippedTotal === 1 ? "row is" : "rows are"} left out of the export (${skipped!.train} train, ${skipped!.eval} eval): the format cannot hold a reply with no assistant text or tool call, or an image or a file.`}
        </p>
      ) : null}
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
        title={`Delete version ${dataset.version}?`}
        description="Its rows are deleted for good. The use case and its other versions stay. This can't be undone."
        confirmLabel="Delete version"
        pending={busy}
        onConfirm={remove}
      />
    </Section>
  );
}

/**
 * The rows of one ready dataset version (RC-1130): the redacted input and
 * output, the side, the source run, and exclude and pin actions. An action
 * changes the use case, never this version: it applies to the next build.
 */
export function DatasetRows({
  rowsHref,
  overridesHref,
  traceRoot,
}: {
  rowsHref: string;
  overridesHref: string;
  traceRoot: string;
}) {
  const [side, setSide] = useState<SideFilter>("all");
  const [rows, setRows] = useState<DatasetRowView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  // The first page of the chosen side; "Show more rows" appends the next ones.
  useEffect(() => {
    let current = true;
    void fetchRows(rowsHref, side, null).then((page) => {
      if (!current) return;
      setLoading(false);
      setError(page.ok ? null : page.message);
      if (page.ok) {
        setRows(page.rows);
        setNextCursor(page.nextCursor);
      }
    });
    return () => {
      current = false;
    };
  }, [rowsHref, side]);

  function chooseSide(value: SideFilter) {
    setLoading(true);
    setRows([]);
    setNextCursor(null);
    setSide(value);
  }

  async function more(cursor: string) {
    setLoading(true);
    const page = await fetchRows(rowsHref, side, cursor);
    setLoading(false);
    setError(page.ok ? null : page.message);
    if (page.ok) {
      setRows((current) => [...current, ...page.rows]);
      setNextCursor(page.nextCursor);
    }
  }

  async function change(row: DatasetRowView, patch: { pinned?: boolean; excluded?: boolean }) {
    setSaving(row.turnId);
    setError(null);
    const response = await fetch(overridesHref, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId: row.turnId, ...patch }),
    });
    const result = (await response.json().catch(() => null)) as {
      ok?: boolean;
      override?: { pinned: boolean; excluded: boolean };
      message?: string;
    } | null;
    setSaving(null);
    if (!response.ok || !result?.ok || !result.override) {
      setError(result?.message ?? "The change was not saved. Try again.");
      return;
    }
    const { pinned, excluded } = result.override;
    // One run can have more than one row: every row of the run shows the change.
    setRows((current) =>
      current.map((other) =>
        other.turnId === row.turnId ? { ...other, pinned, excluded } : other,
      ),
    );
    setChanged(true);
  }

  const columns: Column<DatasetRowView>[] = [
    {
      id: "ordinal",
      header: "#",
      width: "3.5rem",
      align: "right",
      cell: (row) => <span className="tabular-nums text-fg-muted">{row.ordinal + 1}</span>,
    },
    {
      id: "side",
      header: "Side",
      width: "5rem",
      cell: (row) => (
        <Badge tone={row.side === "eval" ? "info" : "neutral"}>
          {row.side === "eval" ? "Eval" : "Train"}
        </Badge>
      ),
    },
    {
      id: "input",
      header: "Input",
      cell: (row) => (
        <RowText messages={row.content?.messages ?? []} system={row.content?.system} />
      ),
    },
    {
      id: "output",
      header: "Output",
      cell: (row) => <RowText messages={row.content?.output ?? []} />,
    },
    {
      id: "source",
      header: "Source",
      width: "7rem",
      hiddenBelow: "md",
      cell: (row) => (
        <Link
          className="text-accent hover:underline"
          href={`${traceRoot}/${encodeURIComponent(row.traceId)}`}
        >
          Open trace
        </Link>
      ),
    },
    {
      id: "actions",
      header: "Next version",
      width: "13rem",
      cell: (row) => (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant={row.excluded ? "primary" : "secondary"}
            disabled={saving === row.turnId}
            aria-pressed={row.excluded}
            onClick={() => change(row, { excluded: !row.excluded })}
          >
            {row.excluded ? "Excluded" : "Exclude"}
          </Button>
          <Button
            size="sm"
            variant={row.pinned ? "primary" : "secondary"}
            disabled={saving === row.turnId || row.excluded}
            aria-pressed={row.pinned}
            onClick={() => change(row, { pinned: !row.pinned })}
          >
            {row.pinned ? "Pinned" : "Pin"}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Section
      title="Rows"
      description="The redacted model calls in this version, in build order."
      actions={
        <Select
          aria-label="Side"
          value={side}
          onValueChange={(value) => chooseSide(value as SideFilter)}
          options={SIDE_OPTIONS}
        />
      }
    >
      <Callout
        tone={changed ? "warning" : "info"}
        title={changed ? "Build again to apply your changes" : "This version does not change"}
      >
        Exclude a run to keep it out of every later version. Pin a run to keep it even when it fails
        a quality rule. A change applies to the next version you build.
      </Callout>
      {error ? (
        <Callout tone="danger" title="Something went wrong">
          {error}
        </Callout>
      ) : null}
      <DataTable
        caption="Dataset rows"
        columns={columns}
        rows={rows}
        rowKey={(row) => String(row.ordinal)}
        empty={
          loading ? (
            <p className="px-3 py-2 text-ui text-fg-muted">Loading rows…</p>
          ) : (
            <EmptyState icon={Rows3} title="No rows" description="No row of this side." />
          )
        }
      />
      {nextCursor ? (
        <div>
          <Button variant="secondary" disabled={loading} onClick={() => void more(nextCursor)}>
            {loading ? "Loading…" : "Show more rows"}
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

/** One page of rows from the rows route. */
async function fetchRows(
  rowsHref: string,
  side: SideFilter,
  cursor: string | null,
): Promise<
  { ok: true; rows: DatasetRowView[]; nextCursor: string | null } | { ok: false; message: string }
> {
  const query = new URLSearchParams({
    limit: "25",
    ...(side === "all" ? {} : { side }),
    ...(cursor ? { cursor } : {}),
  });
  const response = await fetch(`${rowsHref}?${query}`, { cache: "no-store" }).catch(() => null);
  const result = (await response?.json().catch(() => null)) as {
    ok?: boolean;
    rows?: DatasetRowView[];
    nextCursor?: string | null;
    message?: string;
  } | null;
  if (!response?.ok || !result?.ok || !result.rows)
    return { ok: false, message: result?.message ?? "The rows did not load. Try again." };
  return { ok: true, rows: result.rows, nextCursor: result.nextCursor ?? null };
}

/** Messages as plain text, one per line, with tool calls by name. Long text is clamped. */
function RowText({ messages, system }: { messages: readonly CloudMessage[]; system?: string }) {
  const lines = [
    ...(system ? [`system: ${system}`] : []),
    ...messages.map((message) => `${message.role}: ${messageText(message)}`),
  ];
  if (lines.length === 0) return <span className="text-fg-muted">—</span>;
  return (
    <p className="line-clamp-4 whitespace-pre-wrap break-words text-ui text-fg">
      {lines.join("\n")}
    </p>
  );
}

function messageText(message: CloudMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) =>
      block.type === "text"
        ? block.text
        : block.type === "tool_call"
          ? `[calls ${block.name}]`
          : `[${block.type}]`,
    )
    .join(" ");
}
