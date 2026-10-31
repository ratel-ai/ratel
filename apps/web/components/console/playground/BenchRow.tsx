"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { ChevronRight, Pencil } from "lucide-react";
import { useState } from "react";
import { fmtCost, fmtCount } from "@/lib/platform/format";
import type { BenchEntry, BenchSaveAffordance } from "@/lib/synthesis/playground/bench-view";
import { isUndescribed, resolveOverrideSave } from "@/lib/synthesis/playground/bench-view";
import { Tooltip } from "./BenchTooltip";
import { CatalogProvenanceBadge } from "./CatalogProvenanceBadge";
import { DescriptionPanel, PANEL_PRIMARY_BUTTON } from "./DescriptionPanel";
import { PartialDataValue } from "./PartialDataValue";
import { TagInput } from "./TagInput";

const SECONDARY =
  "border-forest-300 bg-forest-600/70 hover:border-forest-300/80 hover:bg-forest-600";
const GHOST = "text-warm-muted hover:bg-forest/40 hover:text-cream";

/** One capability on the bench: */
export function BenchRow({
  entry,
  open,
  editing,
  onToggle,
  onEdit,
  onCancelEdit,
  saved,
  tags,
  onCommit,
  onRevert,
  onSaveToCatalog,
  saveAffordance,
  saving,
}: {
  entry: BenchEntry;
  open: boolean;
  /** Open AND in the editor. Owned above so only one row edits at a time. */
  editing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  /** The stored match text, shown as the "was" line when edited. */
  saved: string;
  /** Skills only: the effective tag list. */
  tags: readonly string[] | null;
  /** Commit the editor's buffer as the what-if edit. Only fired by Save. */
  onCommit: (description: string, tags: string[] | null) => void;
  onRevert: () => void;
  /** Write the edit through, given the exact text to persist, or null to clear a Cloud override and hand the text back to the runtime. */
  onSaveToCatalog: ((description: string | null) => void) | null;
  /** What Save does here, or why it can't. */
  saveAffordance: BenchSaveAffordance;
  saving: boolean;
}) {
  const blank = isUndescribed(entry);
  return (
    <div
      className={cn(
        "group/row border-l-2 transition-colors",
        entry.edited ? "border-l-coral" : "border-l-transparent",
        open && "bg-base-deep/25",
      )}
    >
      <div className="flex items-center">
        <Button
          variant="ghost"
          onClick={onToggle}
          aria-expanded={open}
          className="h-auto min-w-0 flex-1 shrink justify-start gap-2 rounded-none border-0 py-1.5 pr-0 pl-3 text-left font-normal transition-colors hover:bg-forest/25 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-offset-0"
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-warm-muted transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          {entry.rank !== null && (
            <span className="w-5 shrink-0 rounded bg-indigo-300/15 text-center font-mono text-[10px] tabular-nums text-indigo-300">
              {entry.rank}
            </span>
          )}
          <span className="shrink-0 font-mono text-[11px] text-cream">{entry.id}</span>
          <CatalogProvenanceBadge provenance={entry.provenance} />
          {entry.status === "draft" && (
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-ctx-tools">
              draft
            </span>
          )}
          {blank && (
            <span
              className="shrink-0 font-mono text-[10px] text-ctx-tools"
              title="No description, so nothing to match a prompt against. This capability can never be retrieved."
            >
              no description
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {entry.edited && !open && (
              <span className="font-mono text-[10px] text-coral">edited</span>
            )}
            {entry.calls !== null && entry.calls > 0 && (
              <span
                className="font-mono text-[10px] tabular-nums text-warm-muted"
                title={`Called ${entry.calls.toLocaleString("en-US")} times in retained telemetry`}
              >
                {entry.calls.toLocaleString("en-US")} calls
              </span>
            )}
            {entry.tokensProvenance !== null && (
              <span className="font-mono text-[10px] tabular-nums text-warm-muted">
                <PartialDataValue
                  source={entry.tokensProvenance}
                  hint="Approximate input tokens attributed to this tool, reconstructed from OpenTelemetry."
                >
                  {fmtCount(entry.tokens ?? 0)}
                </PartialDataValue>{" "}
                tokens
              </span>
            )}
            {entry.costProvenance !== null && (
              <span className="font-mono text-[10px] tabular-nums text-warm-muted">
                <PartialDataValue
                  source={entry.costProvenance}
                  hint="Approximate event cost attributed by this tool's share of input tokens."
                >
                  {fmtCost(entry.costUsd ?? 0)}
                </PartialDataValue>
              </span>
            )}
          </span>
        </Button>

        <Button
          variant="ghost"
          onClick={onEdit}
          aria-label={`Edit the description for ${entry.id}`}
          title="Edit this description"
          className={cn(
            "mr-2 ml-1 size-auto rounded border-0 p-1 text-warm-muted transition-[color,background-color,opacity] hover:bg-forest/50 hover:text-cream focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-indigo-300/60 focus-visible:ring-offset-0",
            editing
              ? "bg-forest/50 text-indigo-300 opacity-100"
              : "opacity-0 group-hover/row:opacity-100",
          )}
        >
          <Pencil className="size-3" aria-hidden />
        </Button>
      </div>

      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="border-t border-forest-300/40 px-3 pt-2 pb-3">
            {editing ? (
              <Editor
                key={entry.description}
                entry={entry}
                tags={tags}
                saving={saving}
                onCancel={onCancelEdit}
                onCommit={onCommit}
                onSaveToCatalog={onSaveToCatalog}
                saveAffordance={saveAffordance}
              />
            ) : (
              <ReadView
                entry={entry}
                tags={tags}
                saved={saved}
                blank={blank}
                saving={saving}
                onEdit={onEdit}
                onRevert={onRevert}
                onSaveToCatalog={onSaveToCatalog}
                saveAffordance={saveAffordance}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The description as it stands, plus what you can do about it. */
/** The description as it stands, plus what you can do about it. */
function ReadView({
  entry,
  tags,
  saved,
  blank,
  saving,
  onEdit,
  onRevert,
  onSaveToCatalog,
  saveAffordance,
}: {
  entry: BenchEntry;
  tags: readonly string[] | null;
  saved: string;
  blank: boolean;
  saving: boolean;
  onEdit: () => void;
  onRevert: () => void;
  onSaveToCatalog: ((description: string | null) => void) | null;
  saveAffordance: BenchSaveAffordance;
}) {
  return (
    <>
      {blank ? (
        <p className="whitespace-pre-wrap text-xs leading-relaxed italic text-warm-muted/60">
          {entry.kind === "tool"
            ? "No description has ever been synced for this tool, so there is nothing for a prompt to match. Write one here to see what it would rank."
            : "No description, so nothing for a prompt to match."}
        </p>
      ) : (
        <DescriptionPanel
          agentDescription={entry.agentDescription ?? entry.description}
          searchableDescription={entry.description}
          isOverride={entry.searchableDescriptionSource === "override"}
          showSource={entry.provenance === "managed"}
        />
      )}

      {tags && tags.length > 0 && (
        <p className="mt-1.5 flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded border border-forest-300 px-1.5 py-px font-mono text-[10px] text-warm-muted"
            >
              {tag}
            </span>
          ))}
        </p>
      )}

      {entry.edited && (
        <p className="mt-2 text-[11px] leading-relaxed text-warm-muted">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em]">saved</span>{" "}
          <span className="line-through decoration-warm-muted/40">
            {saved || "(no description)"}
          </span>
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="secondary"
          className={SECONDARY}
          onClick={onEdit}
          disabled={saving}
        >
          Edit
        </Button>
        {entry.edited && (
          <>
            <Button
              size="xs"
              variant="ghost"
              className={GHOST}
              onClick={onRevert}
              disabled={saving}
            >
              Discard
            </Button>
            {onSaveToCatalog && saveAffordance.kind !== "blocked" ? (
              <Button
                size="xs"
                variant="inverse"
                onClick={() => onSaveToCatalog(entry.description)}
                disabled={saving || blank}
              >
                {saving ? "Saving…" : saveAffordance.label}
              </Button>
            ) : (
              <span className="text-[11px] text-warm-muted">
                {saveAffordance.kind === "blocked" ? saveAffordance.reason : null}
              </span>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** The editor. */
function Editor({
  entry,
  tags,
  saving,
  onCancel,
  onCommit,
  onSaveToCatalog,
  saveAffordance,
}: {
  entry: BenchEntry;
  tags: readonly string[] | null;
  saving: boolean;
  onCancel: () => void;
  onCommit: (description: string, tags: string[] | null) => void;
  /** Null clears the Cloud override; a string stores one. */
  onSaveToCatalog: ((description: string | null) => void) | null;
  saveAffordance: BenchSaveAffordance;
}) {
  const [value, setValue] = useState(entry.description);
  const [draftTags, setDraftTags] = useState<string[]>([...(tags ?? [])]);
  const agentDescription = entry.agentDescription ?? entry.description;
  const isOverride = entry.searchableDescriptionSource === "override";
  const savable = onSaveToCatalog !== null && saveAffordance.kind !== "blocked";
  /** On the bench, the pencil IS the override. */
  const authoringOverride = savable && entry.provenance === "managed";
  const dirty =
    value !== entry.description || (tags !== null && draftTags.join(" ") !== tags.join(" "));

  return (
    <>
      <DescriptionPanel
        agentDescription={agentDescription}
        searchableDescription={entry.description}
        isOverride={authoringOverride || isOverride}
        showSource={entry.provenance === "managed"}
        editing={{
          inputId: `bench-searchable-${entry.id}`,
          value,
          active: true,
          persistable: savable,
          onChange: setValue,
          onSave: savable
            ? () => onSaveToCatalog?.(resolveOverrideSave(value, entry.runtimeDefault))
            : () => undefined,
          onReset: savable ? () => onSaveToCatalog?.(null) : () => undefined,
          onMatchAgent: () => setValue(agentDescription),
          canSave: savable && value !== entry.description,
          saving,
          saveLabel: "Save to catalog",
          confirmSave: {
            question: "Write this to the project catalog?",
            body: "Everything else on this page stays in your browser. This writes to the project, and agents will match on the new text from their next sync.",
            confirmLabel: "Save to catalog",
          },
          error: saveAffordance.kind === "blocked" ? saveAffordance.reason : null,
          extraActions: (
            <>
              <Button
                size="xs"
                variant="ghost"
                className={GHOST}
                onClick={onCancel}
                disabled={saving}
              >
                Cancel
              </Button>
              <Tooltip content="Ranks this wording on the next run. Kept in this browser only; nothing is written to the catalog.">
                <Button
                  variant="inverse"
                  onClick={() => onCommit(value, tags === null ? null : draftTags)}
                  disabled={!dirty || saving}
                  aria-label="Test without saving. Ranks this wording on the next run and is kept in this browser only; nothing is written to the catalog."
                  className={PANEL_PRIMARY_BUTTON}
                >
                  Test without saving
                </Button>
              </Tooltip>
            </>
          ),
        }}
      />

      {tags && (
        <div className="mt-1.5">
          <TagInput tags={draftTags} onChange={setDraftTags} label={`Tags for ${entry.id}`} />
        </div>
      )}
    </>
  );
}
