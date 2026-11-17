"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Dialog, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { Plus } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import { resetModelPriceAction, saveModelPriceAction } from "@/lib/console/model-pricing/actions";
import { formatRate } from "@/lib/ingest/model-pricing/format";
import type { ModelPricingRow, PriceField, PriceSource } from "@/lib/ingest/model-pricing/settings";
import type { ModelPriceInput } from "@/lib/ingest/model-pricing/store";

/**
 * The models this project's calls used and the price each pays (RC-482).
 * Unpriced models lead, flagged, because their calls show no cost. An admin
 * sets a price, resets it to the built-in one, or prices a model by hand.
 * Members see the table read-only.
 */

const SOURCE: Record<PriceSource, { tone: "warning" | "info" | "neutral"; label: string }> = {
  unpriced: { tone: "warning", label: "Unpriced" },
  custom: { tone: "info", label: "Custom" },
  "built-in": { tone: "neutral", label: "Built-in" },
};

type Editing = { model: string; fixedModel: boolean; price: ModelPriceInput | null } | null;

export function ModelPricingTable({
  projectId,
  rows,
  canEdit,
}: {
  projectId: string;
  rows: ModelPricingRow[];
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [pending, startTransition] = useTransition();
  const unpriced = rows.filter((row) => row.source === "unpriced");

  function reset(row: ModelPricingRow) {
    const model = row.customModel ?? row.model;
    const previous = row.price;
    startTransition(async () => {
      const result = await resetModelPriceAction(projectId, model);
      if (!result.ok) {
        toast({ title: "Couldn't reset the price", description: result.error, tone: "danger" });
        return;
      }
      toast({
        title: `${model} uses the built-in price`,
        description: "Its stored calls are being re-priced.",
        tone: "success",
        ...(previous
          ? {
              action: {
                label: "Undo",
                onClick: () => {
                  void saveModelPriceAction(projectId, { model, ...previous });
                },
              },
            }
          : {}),
      });
    });
  }

  const columns: Column<ModelPricingRow>[] = [
    {
      id: "model",
      header: "Model",
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-xs text-fg" title={row.model}>
            {row.model}
          </span>
          {row.customModel && row.customModel !== row.model ? (
            <span className="truncate text-xs text-fg-subtle">Priced as {row.customModel}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "source",
      header: "Price",
      width: "7rem",
      cell: (row) => <StatusDot tone={SOURCE[row.source].tone} label={SOURCE[row.source].label} />,
    },
    {
      id: "calls",
      header: "Calls, 30 days",
      align: "right",
      width: "8rem",
      hiddenBelow: "md",
      cell: (row) => callsCell(row),
    },
    {
      id: "input",
      header: "Input",
      align: "right",
      width: "6rem",
      cell: (row) => rateCell(row, "input"),
    },
    {
      id: "cached",
      header: "Cached input",
      align: "right",
      width: "7rem",
      hiddenBelow: "lg",
      cell: (row) => rateCell(row, "cachedInput"),
    },
    {
      id: "write",
      header: "Cache write",
      align: "right",
      width: "7rem",
      hiddenBelow: "lg",
      cell: (row) => rateCell(row, "cacheWrite"),
    },
    {
      id: "output",
      header: "Output",
      align: "right",
      width: "6rem",
      cell: (row) => rateCell(row, "output"),
    },
  ];
  if (canEdit) {
    columns.push({
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: "11rem",
      cell: (row) => (
        <span className="flex justify-end gap-1">
          {row.source === "custom" ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => reset(row)}>
              Reset
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={row.source === "unpriced" ? "secondary" : "ghost"}
            onClick={() =>
              setEditing({
                model: row.customModel ?? row.model,
                fixedModel: true,
                price: row.price,
              })
            }
          >
            {row.source === "unpriced" ? "Set price" : "Edit price"}
          </Button>
        </span>
      ),
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {unpriced.length > 0 ? (
        <Callout
          tone="warning"
          title={
            unpriced.length === 1
              ? "1 model has no price"
              : `${unpriced.length} models have no price`
          }
        >
          {canEdit
            ? "Their calls show Unpriced instead of a cost. Set a price and their stored calls get one."
            : "Their calls show Unpriced instead of a cost. An organization admin can set a price."}
        </Callout>
      ) : null}
      <div className="rounded-lg border border-line bg-raised">
        <DataTable
          caption="Model prices"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.model}
          empty={
            <EmptyState
              title="No model calls yet"
              description="Models show up here once your agent's calls arrive. You can price a model ahead of time."
              action={
                canEdit ? (
                  <Button
                    variant="secondary"
                    onClick={() => setEditing({ model: "", fixedModel: false, price: null })}
                  >
                    Add model
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </div>
      {canEdit && rows.length > 0 ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditing({ model: "", fixedModel: false, price: null })}
          >
            <Plus className="size-4" strokeWidth={1.5} aria-hidden />
            Add model
          </Button>
        </div>
      ) : null}
      {!canEdit ? (
        <p className="text-ui text-fg-muted">Only organization admins can change model prices.</p>
      ) : null}
      <PriceDialog projectId={projectId} editing={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function callsCell(row: ModelPricingRow) {
  if (row.calls === 0) return <span className="text-fg-subtle">None yet</span>;
  // Calls stored before the model had a price: the cost backfill gives them one.
  const uncosted = row.source !== "unpriced" && row.unpricedCalls > 0;
  return (
    <span className="flex flex-col items-end">
      <span className="tabular-nums">{row.calls.toLocaleString("en-US")}</span>
      {uncosted ? (
        <span className="text-xs text-fg-subtle tabular-nums">
          {row.unpricedCalls.toLocaleString("en-US")} without a cost
        </span>
      ) : null}
    </span>
  );
}

function rateCell(row: ModelPricingRow, field: keyof ModelPriceInput) {
  if (!row.price) return <span className="text-fg-subtle">Not set</span>;
  const value = row.price[field];
  if (value === undefined) return <span className="text-fg-subtle">{formatRate(value)}</span>;
  return <span className="tabular-nums">{formatRate(value)}</span>;
}

const FIELDS: { field: Exclude<PriceField, "model">; label: string; optional: boolean }[] = [
  { field: "input", label: "Input", optional: false },
  { field: "output", label: "Output", optional: false },
  { field: "cachedInput", label: "Cached input", optional: true },
  { field: "cacheWrite", label: "Cache write", optional: true },
];

/** Set one model's price: four rates in USD per 1M tokens (DESIGN.md: a short form is a Dialog). */
function PriceDialog({
  projectId,
  editing,
  onClose,
}: {
  projectId: string;
  editing: Editing;
  onClose: () => void;
}) {
  return (
    <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {editing ? (
        <PriceForm
          key={editing.model || "new"}
          projectId={projectId}
          editing={editing}
          onClose={onClose}
        />
      ) : null}
    </Dialog>
  );
}

function PriceForm({
  projectId,
  editing,
  onClose,
}: {
  projectId: string;
  editing: NonNullable<Editing>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<PriceField, string>>({
    model: editing.model,
    input: editing.price ? String(editing.price.input) : "",
    output: editing.price ? String(editing.price.output) : "",
    cachedInput: editing.price?.cachedInput !== undefined ? String(editing.price.cachedInput) : "",
    cacheWrite: editing.price?.cacheWrite !== undefined ? String(editing.price.cacheWrite) : "",
  });
  const [error, setError] = useState<{ field?: PriceField; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const result = await saveModelPriceAction(projectId, values);
      if (!result.ok) {
        setError({ field: result.field, message: result.error });
        if (result.field)
          document
            .querySelector<HTMLInputElement>(
              `form[aria-label="Model price"] [name="${result.field}"]`,
            )
            ?.focus();
        return;
      }
      toast({
        title: `${result.model} price saved`,
        description: "Its stored calls are being re-priced.",
        tone: "success",
      });
      onClose();
    });
  }

  const set = (field: PriceField) => (event: { currentTarget: HTMLInputElement }) => {
    const value = event.currentTarget.value;
    setValues((current) => ({ ...current, [field]: value }));
    setError(null);
  };

  return (
    <DialogContent
      title={editing.fixedModel ? `Price of ${editing.model}` : "Add a model price"}
      description="USD per 1M tokens. New calls pay it at once, and stored calls are re-priced."
    >
      <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Model price">
        <Field
          label="Model id"
          description={
            editing.fixedModel
              ? undefined
              : "As your calls report it, for example gpt-4o. Dated ids pay the same price."
          }
          error={error?.field === "model" ? error.message : null}
        >
          {(control) => (
            <Input
              {...control}
              name="model"
              value={values.model}
              readOnly={editing.fixedModel}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onChange={set("model")}
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          {FIELDS.map(({ field, label, optional }) => (
            <Field
              key={field}
              label={label}
              description={optional ? "Empty: same as input" : undefined}
              error={error?.field === field ? error.message : null}
            >
              {(control) => (
                <Input
                  {...control}
                  name={field}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={optional ? "Same as input" : "0.00"}
                  value={values[field]}
                  className="tabular-nums"
                  onChange={set(field)}
                />
              )}
            </Field>
          ))}
        </div>
        {error && !error.field ? (
          <p role="alert" className="text-ui text-danger">
            {error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            {pending ? "Saving…" : "Save price"}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
