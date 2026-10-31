"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { CodeBlock } from "@ratel/design-system/code";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { Skeleton } from "@ratel/design-system/states";
import { ChevronRight, Eye, Info } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
  fmtCompact,
  fmtDateTime,
  fmtDay,
  fmtMoney,
  fmtRelative,
} from "@/lib/console/catalog/format";
import type { CatalogItem, SkillItem, ToolItem } from "@/lib/console/catalog/items";
import { adoptionNotice, matchesAgentDescription } from "@/lib/console/catalog/searchable";
import { CATALOG_DESCRIPTIONS, CATALOG_STALE_DAYS } from "@/lib/ingest/catalogs/vocabulary";
import { APP_NAME } from "@/lib/platform/app-config";
import { ProvenanceBadge, provenanceHint, SkillStatusDot } from "./ProvenanceBadge";
import { SearchableDescription } from "./SearchableDescription";
import type { SkillBodyLoader } from "./skill-body";

export type DetailLayout = "pane" | "panel";

export interface CatalogItemDetailProps {
  item: CatalogItem;
  /** The server's "now", so relative times hydrate as they rendered. */
  now: string;
  /** In a pane the detail carries its own heading; in a Panel the Panel's title names it. */
  layout: DetailLayout;
  /** The tree group it sits in ("kanban"), for the pane's subtitle. */
  groupLabel?: string | null;
  /** Evidence that the runtime picks up Cloud copies, per kind; null when there is none. */
  adopted?: { tool: boolean | null; skill: boolean | null };
  onSaveSearchable?: (item: CatalogItem, draft: string) => Promise<string | null>;
  onResetSearchable?: (item: CatalogItem) => Promise<string | null>;
  /** The item's unsaved searchable-description draft, kept by the caller across item switches. */
  draft?: string | null;
  onDraftChange?: (item: CatalogItem, draft: string | null) => void;
  /** Fetches a Cloud skill's instructions when the page loaded the skill without them. */
  loadSkillBody?: SkillBodyLoader;
  /** Skill actions (publish, archive, edit) beside the pane's heading. */
  actions?: ReactNode;
}

/**
 * Everything about one tool or skill: how it is found (the searchable
 * description, editable here), what the agent gets (read only), how much it is
 * used, and its definition on demand. The same component fills the tree's
 * right pane and the tools and skills Panels.
 */
export function CatalogItemDetail({
  item,
  now,
  layout,
  groupLabel = null,
  adopted = { tool: null, skill: null },
  onSaveSearchable,
  onResetSearchable,
  draft = null,
  onDraftChange,
  loadSkillBody,
  actions,
}: CatalogItemDetailProps) {
  const titleId = useId();
  const searchable = item.searchable;
  const notice = searchable
    ? adoptionNotice(searchable, item.kind === "tool" ? adopted.tool : adopted.skill)
    : null;
  const canReset = searchable?.target.type === "runtime" && searchable.target.override !== null;

  return (
    <article
      aria-labelledby={layout === "pane" ? titleId : undefined}
      data-catalog-item={item.key}
      className="flex flex-col gap-6"
    >
      {layout === "pane" ? (
        <header className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={titleId} className="min-w-0 truncate font-mono text-sm font-semibold text-fg">
              {item.name}
            </h2>
            <ItemBadges item={item} />
            {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
          </div>
          <p className="text-xs text-fg-subtle">{subtitle(item, groupLabel)}</p>
        </header>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <ItemBadges item={item} />
          <span className="text-xs text-fg-subtle">{provenanceHint(item.provenance)}</span>
        </div>
      )}

      {searchable ? (
        <SearchableDescription
          key={item.key}
          searchable={searchable}
          onSave={(draft) =>
            onSaveSearchable?.(item, draft) ??
            Promise.resolve("This description can't be edited here.")
          }
          onReset={canReset && onResetSearchable ? () => onResetSearchable(item) : undefined}
          notice={notice ? <AdoptionNote notice={notice} kind={item.kind} /> : null}
          initialDraft={draft}
          onDraftChange={onDraftChange ? (next) => onDraftChange(item, next) : undefined}
        />
      ) : null}

      {item.agentDescription !== null ? (
        <section
          aria-labelledby={`${titleId}-agent`}
          data-field="agent-description"
          className="flex flex-col gap-2"
        >
          <div>
            <h3 id={`${titleId}-agent`} className="text-xs font-medium text-fg-muted">
              {CATALOG_DESCRIPTIONS.agent.label}
            </h3>
            <p className="text-xs text-fg-subtle">
              {CATALOG_DESCRIPTIONS.agent.hint}
              {/* A Cloud skill`s description is ${APP_NAME}`s own, changed with the rest of the skill. */}
              {item.provenance === "cloud" ? null : " Read only."}
            </p>
          </div>
          {searchable && matchesAgentDescription(searchable, item.agentDescription) ? (
            <p className="text-sm text-fg-muted">Same text as the searchable description.</p>
          ) : (
            <p className="text-sm whitespace-pre-wrap text-fg">{item.agentDescription}</p>
          )}
        </section>
      ) : null}

      {item.provenance === "observed" ? <ObservedNote kind={item.kind} /> : null}

      <section aria-labelledby={`${titleId}-usage`} className="flex flex-col gap-2">
        <h3 id={`${titleId}-usage`} className="text-xs font-medium text-fg-muted">
          Usage
        </h3>
        <UsageStats item={item} now={now} layout={layout} />
      </section>

      {item.kind === "tool" ? (
        <ToolDefinition item={item} />
      ) : (
        <SkillDefinition item={item} loadBody={loadSkillBody} />
      )}
    </article>
  );
}

function ItemBadges({ item }: { item: CatalogItem }) {
  return (
    <>
      <ProvenanceBadge provenance={item.provenance} />
      {item.kind === "tool" && item.stale ? (
        <Badge tone="warning">Not synced in {CATALOG_STALE_DAYS} days</Badge>
      ) : null}
      {item.kind === "skill" && item.status ? <SkillStatusDot status={item.status} /> : null}
    </>
  );
}

function subtitle(item: CatalogItem, groupLabel: string | null): string {
  const kind = item.kind === "tool" ? "Tool" : "Skill";
  return [groupLabel ? `${kind} in ${groupLabel}` : kind, provenanceHint(item.provenance)].join(
    " · ",
  );
}

function AdoptionNote({
  notice,
  kind,
}: {
  notice: "still-own-copy" | "may-use-own-copy";
  kind: CatalogItem["kind"];
}) {
  const pickUp =
    kind === "tool"
      ? `It picks this up once it attaches with ${APP_NAME} definitions.`
      : `It picks this up once it reads through the ${APP_NAME} catalog loader.`;
  return (
    <p role="note" className="flex items-start gap-1.5 text-xs text-fg-subtle">
      <Info aria-hidden strokeWidth={1.5} className="mt-px size-3.5 shrink-0 text-info" />
      <span>
        {notice === "still-own-copy"
          ? `Saved in ${APP_NAME}. Your runtime is still using its own copy.`
          : `Saved in ${APP_NAME}. Your runtime may still be using its own copy.`}{" "}
        {pickUp}
      </span>
    </p>
  );
}

function ObservedNote({ kind }: { kind: CatalogItem["kind"] }) {
  return (
    <p role="note" className="flex items-start gap-2 text-sm text-fg-muted">
      <Eye aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
      <span>
        Seen in traces only, so there is no definition to show. Register this {kind} through the
        Ratel runtime and its searchable description becomes editable here.
      </span>
    </p>
  );
}

function lastSeenStat(label: string, iso: string | null, now: string): StatProps {
  if (!iso) return { label, value: "Never" };
  const day = fmtDay(iso);
  // Past a month the relative form is the day itself; say it once.
  const relative = fmtRelative(iso, now);
  return {
    label,
    value: day,
    hint: relative === day ? undefined : <span title={fmtDateTime(iso)}>{relative}</span>,
  };
}

function UsageStats({
  item,
  now,
  layout,
}: {
  item: CatalogItem;
  now: string;
  layout: DetailLayout;
}) {
  const stats: StatProps[] =
    item.kind === "tool"
      ? [
          {
            label: "Calls",
            value: fmtCompact(item.calls),
            hint: item.callsEstimated ? "Estimated from traces" : undefined,
          },
          { label: "Input tokens", value: item.tokens === null ? "None" : fmtCompact(item.tokens) },
          { label: "Cost", value: item.costUsd === null ? "None" : fmtMoney(item.costUsd) },
          lastSeenStat("Last seen", item.lastSeenAt, now),
        ]
      : [
          { label: "Runs", value: fmtCompact(item.runs) },
          lastSeenStat(item.record ? "Last run" : "Last seen", item.lastSeenAt, now),
          ...(item.updatedAt ? [lastSeenStat("Updated", item.updatedAt, now)] : []),
        ];
  // A Panel is narrow: four numbers read better as two rows of two.
  return (
    <StatRow
      stats={stats}
      className={cn(layout === "panel" && stats.length === 4 && "lg:grid-cols-2")}
    />
  );
}

/**
 * Reference material, closed until asked for: schemas and instructions are the
 * tallest things here. The content mounts on the first open and stays, so what
 * it loads, it loads once.
 */
function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const regionId = useId();
  const buttonId = useId();
  return (
    <section className="rounded-lg border border-line">
      <h3>
        <button
          id={buttonId}
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => {
            setOpen(!open);
            setOpened(true);
          }}
          className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-ui font-medium text-fg-muted outline-none transition-colors duration-120 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-160 ease-enter motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          {title}
        </button>
      </h3>
      {/* biome-ignore lint/a11y/useSemanticElements: a disclosure panel inside a section; an explicit region keeps it labelled by its button. */}
      <div
        id={regionId}
        role="region"
        aria-labelledby={buttonId}
        hidden={!open}
        className="border-t border-line p-3"
      >
        {opened ? <div className="flex flex-col gap-4">{children}</div> : null}
      </div>
    </section>
  );
}

function Facts({ rows }: { rows: readonly { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-2 text-ui">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-fg-subtle">{row.label}</dt>
          <dd className="min-w-0 break-words text-fg">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function hasSchema(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function ToolDefinition({ item }: { item: ToolItem }) {
  const definition = item.definition;
  if (!definition) return null;
  return (
    <Disclosure title="Definition">
      <Facts
        rows={[
          {
            label: "Tags",
            value: definition.tags.length > 0 ? definition.tags.join(", ") : "None",
          },
          ...(item.source
            ? [
                {
                  label: "Runtime source",
                  value: <code className="font-mono text-xs">{item.source}</code>,
                },
              ]
            : []),
        ]}
      />
      {hasSchema(definition.inputSchema) ? (
        <CodeBlock
          caption="Input schema"
          samples={[{ label: "JSON", code: json(definition.inputSchema) }]}
          className="[&_pre]:max-h-80"
        />
      ) : null}
      {hasSchema(definition.outputSchema) ? (
        <CodeBlock
          caption="Output schema"
          samples={[{ label: "JSON", code: json(definition.outputSchema) }]}
          className="[&_pre]:max-h-80"
        />
      ) : null}
      {!hasSchema(definition.inputSchema) && !hasSchema(definition.outputSchema) ? (
        <p className="text-xs text-fg-subtle">
          Your runtime did not send an input or output schema for this tool.
        </p>
      ) : null}
    </Disclosure>
  );
}

function SkillDefinition({ item, loadBody }: { item: SkillItem; loadBody?: SkillBodyLoader }) {
  const record = item.record;
  if (record) {
    return (
      <Disclosure title="Instructions">
        <Facts
          rows={[
            { label: "Tags", value: record.tags.length > 0 ? record.tags.join(", ") : "None" },
            {
              label: "Tools",
              value:
                record.tools.length > 0 ? (
                  <code className="font-mono text-xs">{record.tools.join(", ")}</code>
                ) : (
                  "None"
                ),
            },
            {
              label: "Scope",
              value: record.endUserId ? (
                <code className="font-mono text-xs">{record.endUserId}</code>
              ) : (
                "Everyone"
              ),
            },
            { label: "Version", value: <span className="tabular-nums">{record.version}</span> },
            ...(record.model
              ? [
                  {
                    label: "Model",
                    value: <code className="font-mono text-xs">{record.model}</code>,
                  },
                ]
              : []),
          ]}
        />
        <SkillBody key={record.id} id={record.id} body={record.body} load={loadBody} />
      </Disclosure>
    );
  }
  if (item.provenance === "managed" && item.tags.length > 0) {
    return (
      <Disclosure title="Definition">
        <Facts rows={[{ label: "Tags", value: item.tags.join(", ") }]} />
      </Disclosure>
    );
  }
  return null;
}

/**
 * A skill's SKILL.md. Pages that load every skill send the text along; the
 * Catalog home leaves it out (it can run to 256 KB a skill) and fetches it the
 * first time the reader opens Instructions.
 */
function SkillBody({ id, body, load }: { id: string; body: string; load?: SkillBodyLoader }) {
  const missing = body === "" && load !== undefined;
  const [fetched, setFetched] = useState<{ body: string } | { error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Retry trigger; a bump re-runs the load.
  useEffect(() => {
    if (!missing || !load) return;
    let live = true;
    void load(id).then((result) => {
      if (live) setFetched(result.ok ? { body: result.body } : { error: result.error });
    });
    return () => {
      live = false;
    };
  }, [missing, load, id, attempt]);

  const text = body !== "" ? body : fetched && "body" in fetched ? fetched.body : null;
  if (text !== null) {
    return (
      <CodeBlock
        caption="SKILL.md"
        samples={[{ label: "Markdown", code: text }]}
        className="[&_pre]:max-h-96 [&_pre]:whitespace-pre-wrap"
      />
    );
  }
  if (fetched && "error" in fetched) {
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-fg-muted">
        <span className="min-w-0 flex-1">{fetched.error}</span>
        <Button
          size="sm"
          onClick={() => {
            setFetched(null);
            setAttempt((current) => current + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div aria-busy="true" className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <span className="sr-only">Loading the instructions…</span>
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-3 w-5/6" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}
