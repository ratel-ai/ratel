"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button, IconButton } from "@ratel/design-system/button";
import { Field, Input } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import {
  addPivotAction,
  movePivotAction,
  removePivotAction,
  renamePivotAction,
} from "@/lib/console/pivots/actions";
import type { PivotCandidate } from "@/lib/ingest/pivots/candidates";
import {
  MAX_KEY_LENGTH,
  MAX_LABEL_LENGTH,
  PIVOT_LIMIT,
  PIVOT_PRESETS,
  type Pivot,
  type PivotInput,
  pivotKeys,
} from "@/lib/ingest/pivots/model";
import type { PivotSettingsResult } from "@/lib/synthesis/pivots/settings";

/**
 * Settings > Pivots (RC-881, flag `cloud-pivots`): the attributes the project
 * slices its traces by, at most five. A member adds a preset or a custom
 * attribute key, renames, moves and removes them. The first pivot leads every
 * view that reads them. Suggestions are keys found on recent root spans
 * (RC-882), added with one click.
 */
export function PivotsSettings({
  projectId,
  pivots: initial,
  candidates = [],
}: {
  projectId: string;
  pivots: Pivot[];
  candidates?: PivotCandidate[];
}) {
  const [pivots, setPivots] = useState(initial);
  const [pending, startTransition] = useTransition();
  const full = pivots.length >= PIVOT_LIMIT;
  const readKeys = new Set(pivots.flatMap((pivot) => pivotKeys(pivot)));

  function run(
    action: () => Promise<PivotSettingsResult>,
    failure: string,
    success?: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      startTransition(async () => {
        const result = await action();
        if (!result.ok) {
          toast({ title: failure, description: result.error, tone: "danger" });
          resolve(false);
          return;
        }
        setPivots(result.pivots);
        if (success) toast({ title: success, tone: "success" });
        resolve(true);
      });
    });
  }

  const add = (input: PivotInput) =>
    run(() => addPivotAction(projectId, input), "Couldn't add the pivot", "Pivot added");

  return (
    <div className="flex flex-col gap-8">
      <Section
        title="Pivots"
        description={`Slice your traces by an attribute you choose, such as the client company or the end user. Up to ${PIVOT_LIMIT} per project.`}
        actions={
          <span className="text-ui text-fg-muted tabular-nums">{`${pivots.length} of ${PIVOT_LIMIT}`}</span>
        }
        surface={pivots.length > 0}
      >
        {pivots.length === 0 ? (
          <EmptyState title="No pivots yet" description="Add a preset or an attribute key below." />
        ) : (
          <ol className="divide-y divide-line">
            {pivots.map((pivot, index) => (
              <PivotRow
                key={pivot.key}
                pivot={pivot}
                first={index === 0}
                last={index === pivots.length - 1}
                pending={pending}
                onRename={(label) =>
                  run(
                    () => renamePivotAction(projectId, pivot.key, label),
                    "Couldn't rename the pivot",
                  )
                }
                onMove={(direction) =>
                  void run(
                    () => movePivotAction(projectId, pivot.key, direction),
                    "Couldn't move the pivot",
                  )
                }
                onRemove={() =>
                  void run(
                    () => removePivotAction(projectId, pivot.key),
                    "Couldn't remove the pivot",
                    `${pivot.label} removed`,
                  )
                }
              />
            ))}
          </ol>
        )}
      </Section>

      {candidates.length > 0 ? (
        <Section
          title="Suggested"
          description="Keys on your recent runs that split them into a few groups."
        >
          <ul className="divide-y divide-line rounded-lg border border-line bg-raised">
            {candidates
              .filter((candidate) => !readKeys.has(candidate.key))
              .map((candidate) => (
                <li key={candidate.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="flex items-center gap-2 truncate font-mono text-sm text-fg">
                      {candidate.key}
                      {candidate.presetId ? (
                        <Badge tone="info">{presetLabel(candidate.presetId)}</Badge>
                      ) : null}
                    </p>
                    <p className="text-xs text-fg-muted tabular-nums">
                      {`On ${Math.round(candidate.coverage * 100)}% of recent runs · ${candidate.distinct} values`}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={full || pending}
                    onClick={() => void add(suggestionInput(candidate, pivots))}
                  >
                    <Plus aria-hidden />
                    Add
                  </Button>
                </li>
              ))}
          </ul>
        </Section>
      ) : null}

      <Section
        title="Presets"
        description="The attribute keys common SDKs send. A preset reads the first key that has a value."
      >
        <ul className="grid gap-3 sm:grid-cols-2">
          {PIVOT_PRESETS.map((preset) => {
            const added = pivots.some((pivot) => pivot.presetId === preset.id);
            return (
              <li
                key={preset.id}
                className="flex items-start gap-3 rounded-lg border border-line bg-raised px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg">{preset.label}</p>
                  <p className="text-ui text-fg-muted">{preset.description}</p>
                  <p
                    className="mt-1 truncate font-mono text-xs text-fg-subtle"
                    title={preset.keys.join(", ")}
                  >
                    {preset.keys.join(", ")}
                  </p>
                </div>
                {added ? (
                  <Badge tone="success">Added</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={full || pending}
                    onClick={() => void add({ presetId: preset.id })}
                  >
                    <Plus aria-hidden />
                    Add
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <CustomKeyForm disabled={full || pending} onAdd={add} />
    </div>
  );
}

/** A suggestion that a preset reads adds the preset (once); any other adds its key. */
function suggestionInput(candidate: PivotCandidate, pivots: Pivot[]): PivotInput {
  const presetAdded = pivots.some((pivot) => pivot.presetId === candidate.presetId);
  return candidate.presetId && !presetAdded
    ? { presetId: candidate.presetId }
    : { key: candidate.key };
}

function presetLabel(presetId: string): string {
  return PIVOT_PRESETS.find((preset) => preset.id === presetId)?.label ?? presetId;
}

function PivotRow({
  pivot,
  first,
  last,
  pending,
  onRename,
  onMove,
  onRemove,
}: {
  pivot: Pivot;
  first: boolean;
  last: boolean;
  pending: boolean;
  onRename: (label: string) => Promise<boolean>;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(pivot.label);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onRename(label)) setEditing(false);
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 basis-56">
        {editing ? (
          <form onSubmit={submit} className="flex items-center gap-2">
            <Input
              aria-label="Pivot name"
              value={label}
              maxLength={MAX_LABEL_LENGTH}
              autoFocus
              onChange={(event) => setLabel(event.target.value)}
              className="max-w-64"
            />
            <Button size="sm" type="submit" loading={pending}>
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => {
                setLabel(pivot.label);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <p className="flex items-center gap-2 text-sm font-medium text-fg">
            {pivot.label}
            {pivot.presetId ? <Badge>Preset</Badge> : null}
          </p>
        )}
        <p className="mt-0.5 truncate font-mono text-xs text-fg-subtle">
          {pivotKeys(pivot).join(", ")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          label="Move up"
          size="icon-sm"
          icon={<ArrowUp />}
          disabled={first || pending}
          onClick={() => onMove("up")}
        />
        <IconButton
          label="Move down"
          size="icon-sm"
          icon={<ArrowDown />}
          disabled={last || pending}
          onClick={() => onMove("down")}
        />
        <IconButton
          label="Rename"
          size="icon-sm"
          icon={<Pencil />}
          disabled={pending}
          onClick={() => setEditing(true)}
        />
        <IconButton
          label="Remove"
          size="icon-sm"
          icon={<Trash2 />}
          disabled={pending}
          onClick={onRemove}
        />
      </div>
    </li>
  );
}

function CustomKeyForm({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (input: PivotInput) => Promise<boolean>;
}) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onAdd({ key, label })) {
      setKey("");
      setLabel("");
    }
  }

  return (
    <Section
      title="Custom attribute"
      description="Any span or resource attribute key your agent sends, such as customer.tier."
    >
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label="Attribute key" className="min-w-56 flex-1">
          {(control) => (
            <Input
              {...control}
              value={key}
              maxLength={MAX_KEY_LENGTH}
              placeholder="customer.tier"
              className="font-mono"
              onChange={(event) => setKey(event.target.value)}
            />
          )}
        </Field>
        <Field label="Name (optional)" className="min-w-48 flex-1">
          {(control) => (
            <Input
              {...control}
              value={label}
              maxLength={MAX_LABEL_LENGTH}
              placeholder="Customer tier"
              onChange={(event) => setLabel(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="secondary" disabled={disabled || key.trim() === ""}>
          <Plus aria-hidden />
          Add pivot
        </Button>
      </form>
    </Section>
  );
}
