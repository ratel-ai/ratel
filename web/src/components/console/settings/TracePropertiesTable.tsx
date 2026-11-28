"use client";

import { Badge, StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { changeTracePropertyAction } from "@/app/(console)/project/[projectId]/settings/property-actions";
import type { TracePropertyChange } from "@/lib/ingest/properties/actions";
import type { TraceProperty } from "@/lib/ingest/properties/store";

/**
 * The project's trace properties (RTL-395): the standard ones Ratel indexes by itself, and the
 * keys of the user's own it detected. An admin indexes a detected key, stops an indexed one, and
 * erases the values of a stopped one. Members see the table read-only. `?property=<name>` (the link
 * of a form's property that is not indexed, RTL-396) opens the table on that property.
 */

export function TracePropertiesTable({
  projectId,
  rows,
  canChange,
}: {
  projectId: string;
  rows: TraceProperty[];
  canChange: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [erasing, setErasing] = useState<TraceProperty | null>(null);
  const [pending, startTransition] = useTransition();
  const asked = useSearchParams().get("property");
  const focused = rows.find((row) => row.name === asked) ?? null;
  const here = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) here.current?.scrollIntoView({ block: "start" });
  }, [focused]);

  function change(request: TracePropertyChange, done: string) {
    setError(null);
    startTransition(async () => {
      const result = await changeTracePropertyAction(projectId, request);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const description = result.erased
        ? `${result.erased.traces} traces and ${result.erased.spans} spans no longer hold it.`
        : result.filling
          ? "Traces from now on get its value. Stored traces are being filled."
          : undefined;
      toast({ title: done, tone: "success", ...(description ? { description } : {}) });
    });
  }

  const columns: Column<TraceProperty>[] = [
    {
      id: "name",
      header: "Property",
      cell: (row) => (
        <span className="truncate font-mono text-xs text-fg" title={row.name}>
          {row.name}
        </span>
      ),
    },
    {
      id: "source",
      header: "Source",
      width: "7rem",
      cell: (row) => (
        <Badge tone={row.source === "standard" ? "info" : "neutral"}>
          {row.source === "standard" ? "Standard" : "Your own"}
        </Badge>
      ),
    },
    {
      id: "state",
      header: "State",
      width: "8rem",
      cell: (row) => (
        <StatusDot
          tone={row.state === "indexed" ? "success" : "neutral"}
          label={row.state === "indexed" ? "Indexed" : "Detected"}
        />
      ),
    },
    {
      id: "seen",
      header: "Last seen",
      width: "9rem",
      hiddenBelow: "md",
      cell: (row) => (
        <span className="text-ui text-fg-muted">{row.lastSeenAt.toISOString().slice(0, 10)}</span>
      ),
    },
  ];
  if (canChange)
    columns.push({
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: "11rem",
      cell: (row) => actions(row),
    });

  function actions(row: TraceProperty) {
    if (row.column) return <span className="text-ui text-fg-subtle">Always kept</span>;
    if (row.state === "indexed")
      return (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            change(
              { action: "stop", name: row.name },
              `${row.name} is no longer indexed. Its stored values stay until you erase them.`,
            )
          }
        >
          Stop
        </Button>
      );
    return (
      <span className="flex justify-end gap-1">
        {row.indexedAt !== null ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setErasing(row)}>
            Erase
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => change({ action: "index", name: row.name }, `${row.name} is indexed`)}
        >
          Index
        </Button>
      </span>
    );
  }

  return (
    <div ref={here} className="flex flex-col gap-3">
      <p className="text-ui text-fg-muted">
        Ratel stores the key names your traces carry. It stores the values of the standard
        properties by itself, and the values of a property of your own only after you index it.
        Indexing your own properties is on paid plans, up to 20 per project.
      </p>
      {focused && focused.state === "detected" ? (
        <Callout tone="info" title={`${focused.name} is not indexed`}>
          <span className="flex flex-wrap items-center gap-2">
            Index it to filter and group your metrics by it.
            {canChange ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  change({ action: "index", name: focused.name }, `${focused.name} is indexed`)
                }
              >
                Index {focused.name}
              </Button>
            ) : (
              " An organization admin can index it."
            )}
          </span>
        </Callout>
      ) : null}
      {error ? (
        <Callout tone="danger" title="Couldn't change the property">
          {error}
        </Callout>
      ) : null}
      <div className="rounded-lg border border-line bg-raised">
        <DataTable
          caption="Trace properties"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.name}
          selectedKey={focused?.name ?? null}
          empty={
            <EmptyState
              title="No trace properties yet"
              description="Keys show up here once your traces arrive."
            />
          }
        />
      </div>
      <ConfirmDialog
        open={erasing !== null}
        onOpenChange={(open) => {
          if (!open) setErasing(null);
        }}
        title={`Erase the values of ${erasing?.name ?? ""}?`}
        description="Every stored trace of this project loses its value. The key name stays detected."
        confirmLabel="Erase values"
        pending={pending}
        onConfirm={() => {
          if (erasing) change({ action: "erase", name: erasing.name }, `${erasing.name} is erased`);
          setErasing(null);
        }}
      />
    </div>
  );
}
