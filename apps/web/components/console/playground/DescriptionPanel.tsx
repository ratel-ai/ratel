"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Dialog, DialogContent } from "@ratel/design-system/dialog";
import { Textarea } from "@ratel/design-system/input";
import { Bot, CircleHelp, Search } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  CATALOG_DESCRIPTIONS,
  CATALOG_DESCRIPTIONS_SAME,
  CATALOG_DESCRIPTIONS_SAME_LABEL,
  CATALOG_EMPTY_RESETS,
  CATALOG_LAYERS_HELP,
  CATALOG_MATCH_AGENT_ACTION,
  CATALOG_MATCH_AGENT_HELP,
  CATALOG_RESET_ACTION,
  CATALOG_SEARCHABLE_SOURCE,
} from "@/lib/ingest/catalogs/vocabulary";
import { Tooltip } from "./BenchTooltip";
import { FIELD } from "./field";

type CatalogDescriptionRoleKey = keyof typeof CATALOG_DESCRIPTIONS;

export interface DescriptionEditing {
  /** Overrides the Save button's wording. */
  saveLabel?: string;
  /** Make Save a two-step write. */
  confirmSave?: { question: string; body?: string; confirmLabel: string };
  /** Extra controls for the action row, rendered LAST, the trailing edge, where the eye lands and where a safe default belongs. */
  extraActions?: ReactNode;
  /** Draft text, only meaningful while `active` is true. */
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  /** Drop the Cloud override so the runtime's text applies again. */
  onReset: () => void;
  /** Point the override at the agent description. */
  onMatchAgent: () => void;
  /** Whether the field is currently open for editing. */
  active: boolean;
  /** Whether an edit here can be PERSISTED as a Cloud override. */
  persistable?: boolean;
  canSave: boolean;
  saving: boolean;
  message?: string | null;
  error?: string | null;
  inputId: string;
}

/** The two descriptions, shown and edited in one place. */
export function DescriptionPanel({
  agentDescription,
  searchableDescription,
  isOverride,
  showSource = true,
  editing,
}: {
  agentDescription: string;
  /** The text actually used for matching: the Cloud override when one is set. */
  searchableDescription: string;
  /** Whether the searchable text is a Cloud override or the runtime default. */
  isOverride: boolean;
  /** Whether to name where the searchable text comes from. */
  showSource?: boolean;
  editing?: DescriptionEditing;
}) {
  const open = editing?.active === true;
  const persistable = editing?.persistable !== false;
  const [confirming, setConfirming] = useState(false);
  const saveButton = editing ? (
    <Button
      variant="inverse"
      onClick={() => (editing.confirmSave ? setConfirming(true) : editing.onSave())}
      disabled={!editing.canSave || editing.saving}
      className={editing.confirmSave ? DANGER_BUTTON : PRIMARY_BUTTON}
    >
      {editing.saving ? "Saving…" : (editing.saveLabel ?? "Save")}
    </Button>
  ) : null;
  const effectiveSearchable = open ? editing.value : searchableDescription;
  const same = effectiveSearchable.trim() === agentDescription.trim();

  return (
    <section
      data-catalog-descriptions={same ? "identical" : "diverged"}
      className="rounded-lg border border-forest-300/70 bg-forest/20 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <FieldLabel
          label={same ? CATALOG_DESCRIPTIONS_SAME_LABEL : CATALOG_DESCRIPTIONS.searchable.label}
          hint={same ? CATALOG_DESCRIPTIONS_SAME : CATALOG_DESCRIPTIONS.searchable.hint}
          icons={
            same ? (
              <>
                <RoleIcon kind="searchable" />
                <RoleIcon kind="agent" />
              </>
            ) : (
              <RoleIcon kind="searchable" />
            )
          }
        />
        <div className="flex shrink-0 items-center gap-1.5">
          {showSource && <SourceBadge isOverride={isOverride} />}
          <LayersHelp />
        </div>
      </div>

      {open ? (
        <>
          <Textarea
            id={editing.inputId}
            value={editing.value}
            onChange={(event) => {
              setConfirming(false);
              editing.onChange(event.target.value);
            }}
            rows={3}
            placeholder="Words and phrases a prompt is likely to use."
            className={cn(FIELD, "mt-2 min-h-0 resize-y text-xs")}
            aria-label={CATALOG_DESCRIPTIONS.searchable.label}
            aria-invalid={editing.error ? true : undefined}
            aria-describedby={`${editing.inputId}-message`}
          />
          {persistable && (
            <p className="mt-1.5 text-[11px] leading-4 text-warm-muted/70">
              {CATALOG_EMPTY_RESETS}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {persistable && editing.confirmSave && saveButton}
            <span
              id={`${editing.inputId}-message`}
              aria-live="polite"
              className={cn("text-xs", editing.error ? "text-coral" : "text-warm-muted")}
            >
              {editing.error ?? editing.message ?? ""}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {persistable && !same && (
                <ActionReveal>
                  <Tooltip content={CATALOG_MATCH_AGENT_HELP}>
                    <Button
                      variant="outline"
                      onClick={editing.onMatchAgent}
                      disabled={editing.saving}
                      className={SECONDARY_BUTTON}
                    >
                      {CATALOG_MATCH_AGENT_ACTION}
                    </Button>
                  </Tooltip>
                </ActionReveal>
              )}
              {persistable && isOverride && (
                <ActionReveal>
                  <Button
                    variant="outline"
                    onClick={editing.onReset}
                    disabled={editing.saving}
                    className={SECONDARY_BUTTON}
                  >
                    {CATALOG_RESET_ACTION}
                  </Button>
                </ActionReveal>
              )}
              {persistable && !editing.confirmSave && saveButton}
              {editing.extraActions}
            </div>
          </div>

          <Dialog open={confirming && Boolean(editing.confirmSave)} onOpenChange={setConfirming}>
            <DialogContent
              title={editing.confirmSave?.question ?? ""}
              titleClassName="font-display text-lg text-cream"
              description={editing.confirmSave?.body}
              className="max-w-md rounded-xl border-forest-300 bg-base-deep p-6 shadow-2xl"
              footer={
                <>
                  <Button
                    variant="outline"
                    onClick={() => setConfirming(false)}
                    disabled={editing.saving}
                    className={SECONDARY_BUTTON}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setConfirming(false);
                      editing.onSave();
                    }}
                    disabled={editing.saving}
                    className={DANGER_BUTTON_SOLID}
                  >
                    {editing.saving ? "Saving…" : editing.confirmSave?.confirmLabel}
                  </Button>
                </>
              }
            >
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-forest-300/70 bg-forest/20 p-3 text-xs leading-5 text-cream-dim">
                {editing.value.trim() || "(empty, this removes the Cloud override)"}
              </p>
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-cream-dim">
          {effectiveSearchable || "–"}
        </p>
      )}

      {!same && (
        <div className="description-split-enter grid">
          <div className="overflow-hidden">
            <div className="mt-3 border-t border-forest-300/50 pt-3">
              <FieldLabel
                label={CATALOG_DESCRIPTIONS.agent.label}
                hint={CATALOG_DESCRIPTIONS.agent.hint}
                icons={<RoleIcon kind="agent" />}
              />
              <p
                data-catalog-description="agent"
                className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-cream-dim"
              >
                {agentDescription || "–"}
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** A conditional action arriving in a row of permanent ones. */
function ActionReveal({ children }: { children: ReactNode }) {
  return (
    <span className="action-reveal-enter grid">
      <span className="overflow-hidden">{children}</span>
    </span>
  );
}

/** The row's affirmative action. */
export const PANEL_PRIMARY_BUTTON =
  "h-auto rounded-md bg-cream px-3 py-1.5 text-xs font-semibold text-ink shadow-none transition-opacity hover:bg-cream hover:opacity-90 disabled:opacity-40";

const PRIMARY_BUTTON = PANEL_PRIMARY_BUTTON;

/** A write worth pausing over. */
const DANGER_BUTTON =
  "h-auto rounded-md border-coral/35 bg-coral/[0.12] px-3 py-1.5 text-xs font-semibold text-coral transition-colors hover:border-coral/55 hover:bg-coral/20 disabled:opacity-40";

/** The same action, once armed: filled, because now it is the one that fires. */
const DANGER_BUTTON_SOLID =
  "h-auto rounded-md border-coral/60 bg-coral/25 px-3 py-1.5 text-xs font-semibold text-coral transition-colors hover:bg-coral/35 disabled:opacity-40";

/** Exported so a caller's `extraActions` can sit in the row without looking bolted on. */
export const PANEL_SECONDARY_BUTTON =
  "h-auto rounded-md border-forest-300 bg-transparent px-3 py-1.5 text-xs font-medium text-warm-muted transition-colors hover:bg-transparent hover:text-cream disabled:opacity-50";

const SECONDARY_BUTTON = PANEL_SECONDARY_BUTTON;

function RoleIcon({ kind }: { kind: CatalogDescriptionRoleKey }) {
  const Icon = kind === "searchable" ? Search : Bot;
  return (
    <span
      data-catalog-role={kind}
      title={CATALOG_DESCRIPTIONS[kind].label}
      aria-label={CATALOG_DESCRIPTIONS[kind].label}
      role="img"
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded border",
        kind === "searchable"
          ? "border-coral/30 bg-coral/[0.07] text-coral"
          : "border-green/30 bg-green/10 text-green",
      )}
    >
      <Icon className="size-2.5" strokeWidth={1.8} aria-hidden />
    </span>
  );
}

function SourceBadge({ isOverride }: { isOverride: boolean }) {
  const meta = isOverride ? CATALOG_SEARCHABLE_SOURCE.cloud : CATALOG_SEARCHABLE_SOURCE.runtime;
  return (
    <Tooltip content={meta.hint}>
      <span
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the tooltip.
        tabIndex={0}
        className={cn(
          "shrink-0 rounded-full border px-2 py-0.5 font-mono text-[8px] uppercase tracking-[0.08em] outline-none focus-visible:ring-2 focus-visible:ring-coral/50",
          isOverride
            ? "border-coral/35 bg-coral/10 text-coral"
            : "border-forest-300 bg-base-deep/45 text-warm-muted",
        )}
      >
        {meta.label}
      </span>
    </Tooltip>
  );
}

function FieldLabel({ label, hint, icons }: { label: string; hint: string; icons: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-warm-muted/70">
        {icons}
        {label}
      </div>
      <p className="mt-0.5 text-[11px] leading-4 text-warm-muted/80">{hint}</p>
    </div>
  );
}

function LayersHelp() {
  return (
    <Tooltip
      side="bottom"
      content={
        <dl className="space-y-2">
          {CATALOG_LAYERS_HELP.map((layer) => (
            <div key={layer.title}>
              <dt className="font-medium text-cream">{layer.title}</dt>
              <dd className="text-warm-muted">{layer.body}</dd>
            </div>
          ))}
        </dl>
      }
    >
      <button
        type="button"
        aria-label="How the searchable description is resolved"
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-warm-muted/70 outline-none transition-colors hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/50"
      >
        <CircleHelp className="size-3.5" strokeWidth={1.8} aria-hidden />
      </button>
    </Tooltip>
  );
}
