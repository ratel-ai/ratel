"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Textarea } from "@ratel/design-system/input";
import { Panel } from "@ratel/design-system/panel";
import { type KeyboardEvent, type ReactNode, type RefObject, useRef, useState } from "react";
import { ProvenanceBadge } from "@/components/console/catalog/ProvenanceBadge";
import { Highlighted } from "@/components/console/playground/Highlighted";
import { TagInput } from "@/components/console/playground/TagInput";
import { CATALOG_DESCRIPTIONS } from "@/lib/ingest/catalogs/vocabulary";
import type { BenchEntry, BenchSaveAffordance } from "@/lib/synthesis/playground/bench-view";
import { resolveOverrideSave } from "@/lib/synthesis/playground/bench-view";
import { askTerms, sharedWords } from "@/lib/synthesis/playground/matched-words";
import type { ResultRow } from "@/lib/synthesis/playground/result-view";
import type { RankMode } from "@/lib/synthesis/playground/types";
import { formatRankScore } from "@/lib/synthesis/playground/view";

export interface PanelSearch {
  query: string;
  mode: RankMode;
  top: number;
  /** This capability's row in the latest search, or null when it did not place. */
  row: ResultRow | null;
}

/**
 * One tool or skill, opened from a result row (DESIGN.md, Overlays: a Panel,
 * `?peek=` in the URL). It answers two things in order: why it placed where it
 * did, and what a different description would do.
 *
 * The description field is always open. This page is a test bench, so typing
 * is safe: nothing leaves the browser until "Save to catalog", and "Test this
 * description" is the main action because trying is what people came for.
 */
export function CapabilityPanel({
  open,
  onOpenChange,
  entry,
  savedDescription,
  savedTags,
  search,
  saveAffordance,
  saving,
  onTest,
  onDiscard,
  onSave,
  onPrevious,
  onNext,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: BenchEntry | null;
  /** The stored match text, before any of the reader's changes. */
  savedDescription: string;
  /** Skills only: the tags as they stand now, changes applied. Null for tools. */
  savedTags: readonly string[] | null;
  /** Null before the first search. */
  search: PanelSearch | null;
  saveAffordance: BenchSaveAffordance;
  saving: boolean;
  onTest: (description: string, tags: string[] | null) => void;
  onDiscard: () => void;
  onSave: (description: string | null) => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  // Opening a tool is mostly to rewrite it, so the field takes focus.
  const field = useRef<HTMLTextAreaElement>(null);
  if (!entry) {
    return (
      <Panel open={open} onOpenChange={onOpenChange} title="Not in this catalog">
        <p className="text-sm text-fg-muted">
          Nothing in this project&apos;s catalog has that name any more. It may have been renamed or
          removed.
        </p>
      </Panel>
    );
  }

  const noun = entry.kind === "skill" ? "Skill" : "Tool";
  const place = search
    ? search.row
      ? `#${search.row.rank} for this ask`
      : `Not in the top ${search.top} for this ask`
    : null;

  return (
    <Panel
      open={open}
      onOpenChange={onOpenChange}
      title={<span className="font-mono">{entry.id}</span>}
      subtitle={[noun, place].filter(Boolean).join(" · ")}
      onPrevious={onPrevious}
      onNext={onNext}
      initialFocus={field}
    >
      <CapabilityDetails
        fieldRef={field}
        entry={entry}
        savedDescription={savedDescription}
        savedTags={savedTags}
        search={search}
        saveAffordance={saveAffordance}
        saving={saving}
        onTest={onTest}
        onDiscard={onDiscard}
        onSave={onSave}
      />
    </Panel>
  );
}

/** The Panel's body, apart from the Panel so it renders (and tests) on its own. */
export function CapabilityDetails({
  fieldRef,
  entry,
  savedDescription,
  savedTags,
  search,
  saveAffordance,
  saving,
  onTest,
  onDiscard,
  onSave,
}: {
  fieldRef?: RefObject<HTMLTextAreaElement | null>;
  entry: BenchEntry;
  savedDescription: string;
  savedTags: readonly string[] | null;
  search: PanelSearch | null;
  saveAffordance: BenchSaveAffordance;
  saving: boolean;
  onTest: (description: string, tags: string[] | null) => void;
  onDiscard: () => void;
  onSave: (description: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      {search ? <WhyItMatched entry={entry} search={search} /> : null}
      <DescriptionEditor
        // A fresh buffer whenever the text it starts from changes: another
        // capability, a change tested, or one discarded.
        key={`${entry.kind}:${entry.id}:${entry.description}:${(savedTags ?? []).join(",")}`}
        fieldRef={fieldRef}
        entry={entry}
        tags={savedTags}
        saveAffordance={saveAffordance}
        saving={saving}
        onTest={onTest}
        onDiscard={onDiscard}
        onSave={onSave}
        hasSearch={search !== null}
      />
      {/* The closed extras, stacked as one quiet list rather than spaced as sections. */}
      <div className="-mt-2 flex flex-col">
        {entry.edited ? (
          <Disclosure title="Saved description">
            <p className="text-sm whitespace-pre-wrap text-fg-muted">
              {savedDescription.trim() !== "" ? (
                savedDescription
              ) : (
                <span className="text-fg-subtle">Empty</span>
              )}
            </p>
          </Disclosure>
        ) : null}
        <Details entry={entry} row={search?.row ?? null} mode={search?.mode ?? "bm25"} />
      </div>
    </div>
  );
}

function WhyItMatched({ entry, search }: { entry: BenchEntry; search: PanelSearch }) {
  const shared = sharedWords(search.query, [entry.id, entry.description]);
  const keyword = search.mode === "bm25";
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-fg-muted">Why it placed here</h3>
      <blockquote className="border-l-2 border-line-strong pl-3 text-sm text-fg">
        <Highlighted text={search.query} terms={askTerms(shared.join(" "))} />
      </blockquote>
      {/* The lit words are the reason; words only for what the light can't show. */}
      {shared.length === 0 ? (
        <p className="text-xs text-fg-subtle">
          {keyword
            ? "No words in common, so a keyword search can't find it."
            : "No words in common: matched on meaning."}
        </p>
      ) : search.row && search.row.rank > 1 ? (
        <p className="text-xs text-fg-subtle tabular-nums">
          {Math.round(search.row.strength * 100)}% of the first pick&apos;s score
        </p>
      ) : null}
    </section>
  );
}

function DescriptionEditor({
  fieldRef,
  entry,
  tags,
  saveAffordance,
  saving,
  onTest,
  onDiscard,
  onSave,
  hasSearch,
}: {
  fieldRef?: RefObject<HTMLTextAreaElement | null>;
  entry: BenchEntry;
  tags: readonly string[] | null;
  saveAffordance: BenchSaveAffordance;
  saving: boolean;
  onTest: (description: string, tags: string[] | null) => void;
  onDiscard: () => void;
  onSave: (description: string | null) => void;
  hasSearch: boolean;
}) {
  const [value, setValue] = useState(entry.description);
  const [draftTags, setDraftTags] = useState<string[]>([...(tags ?? [])]);
  const dirty =
    value !== entry.description ||
    (tags !== null && draftTags.join("\u0000") !== tags.join("\u0000"));
  const canSave = saveAffordance.kind !== "blocked";
  const fieldId = `searchable-${entry.kind}-${entry.id}`;

  function test() {
    if (!dirty) return;
    onTest(value, tags === null ? null : draftTags);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      test();
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor={fieldId} className="text-xs font-medium text-fg-muted">
          {CATALOG_DESCRIPTIONS.searchable.label}
        </label>
        {entry.edited ? <Badge tone="info">Not saved</Badge> : null}
      </div>
      <Textarea
        ref={fieldRef}
        id={fieldId}
        value={value}
        rows={5}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Use the words people ask with."
        className="text-sm"
      />
      {tags !== null ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${fieldId}-tags`} className="text-xs font-medium text-fg-muted">
            Tags
          </label>
          <TagInput
            id={`${fieldId}-tags`}
            tags={draftTags}
            onChange={setDraftTags}
            label={`Tags for ${entry.id}`}
          />
        </div>
      ) : null}

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={test}>
          {hasSearch ? "Test this description" : "Keep for the next search"}
        </Button>
        {entry.edited ? (
          <Button variant="ghost" size="sm" disabled={saving} onClick={onDiscard}>
            Undo my change
          </Button>
        ) : null}
        {entry.edited && canSave ? (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            loading={saving}
            disabled={dirty}
            onClick={() =>
              onSave(
                entry.kind === "tool" && entry.provenance === "managed"
                  ? resolveOverrideSave(entry.description, entry.runtimeDefault)
                  : entry.description,
              )
            }
          >
            {saving ? "Saving…" : "Save to catalog"}
          </Button>
        ) : null}
      </div>
      {entry.edited && saveAffordance.kind === "blocked" ? (
        <p className="text-xs text-fg-subtle">{saveAffordance.reason}</p>
      ) : null}
    </section>
  );
}

/** The specialist's numbers, closed by default (DESIGN.md, Plain language). */
function Details({
  entry,
  row,
  mode,
}: {
  entry: BenchEntry;
  row: ResultRow | null;
  mode: RankMode;
}) {
  const facts: { label: string; value: ReactNode }[] = [
    { label: "Source", value: <ProvenanceBadge provenance={entry.provenance} /> },
  ];
  if (entry.status)
    facts.push({
      label: "Status",
      value:
        entry.status === "published"
          ? "Published"
          : entry.status === "draft"
            ? "Draft"
            : "Archived",
    });
  if (entry.calls !== null)
    facts.push({ label: "Calls seen", value: entry.calls.toLocaleString("en-US") });
  if (row) {
    facts.push({
      label:
        mode === "bm25"
          ? "Keyword score"
          : mode === "embeddings"
            ? "Semantic score"
            : "Hybrid score",
      value: formatRankScore(row.hit.score),
    });
    if (row.hit.bm25Score !== null)
      facts.push({ label: "Keyword part", value: formatRankScore(row.hit.bm25Score) });
    if (row.hit.embeddingScore !== null)
      facts.push({ label: "Semantic part", value: formatRankScore(row.hit.embeddingScore) });
  }
  return (
    <Disclosure>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-ui">
        {facts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt className="text-fg-subtle">{fact.label}</dt>
            <dd className="text-fg tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {row ? (
        <p className="mt-3 text-xs text-fg-subtle">
          Scores compare results within one search only; they have no fixed scale.
        </p>
      ) : null}
      {/* What the agent is handed once picked: a specialist's question, and
          searches never read it, so it waits here rather than beside the field. */}
      {entry.agentDescription !== null ? (
        <section className="mt-4 flex flex-col gap-1">
          <h3 className="text-xs font-medium text-fg-muted">{CATALOG_DESCRIPTIONS.agent.label}</h3>
          <p className="text-xs text-fg-subtle">{CATALOG_DESCRIPTIONS.agent.hint}</p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-fg-muted">{entry.agentDescription}</p>
        </section>
      ) : null}
    </Disclosure>
  );
}
