"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable, type SortDirection } from "@ratel/design-system/data-table";
import { FilterBar, FilterChip, SearchInput } from "@ratel/design-system/filter-bar";
import { Menu, MenuContent, MenuGroup, MenuItem, MenuTrigger } from "@ratel/design-system/menu";
import { PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { stepIndex } from "@ratel/design-system/peek";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { Tooltip } from "@ratel/design-system/tooltip";
import { Filter, Plus, SearchX } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { SkillEditor } from "@/components/console/catalog/SkillEditor";
import type { SkillFull } from "@/lib/catalog/agent-tools/outputs";
import {
  fmtCompact,
  fmtDateTime,
  fmtExact,
  fmtRelative,
  plural,
} from "@/lib/console/catalog/format";
import {
  itemKey,
  parseItemKey,
  withItemParam,
  withQueryParam,
  withQueryParams,
} from "@/lib/console/catalog/item-id";
import { buildSkillItems, type SkillItem, type SkillTransition } from "@/lib/console/catalog/items";
import type { SkillsCatalogData } from "@/lib/console/catalog/load";
import { pageWindow, parsePage } from "@/lib/console/catalog/paging";
import {
  filterSkillItems,
  resolveSkillsView,
  type SkillsSortKey,
  type SkillsStatusFilter,
  skillUpdatedAt,
  sortSkillItems,
} from "@/lib/console/catalog/skills-view";
import { createSkill, editSkill } from "@/lib/console/explore/client";
import { explainMutationError } from "@/lib/console/explore/errors";
import type { CreateSkillBody, EditSkillBody } from "@/lib/console/explore/forms";
import { CatalogItemDetail } from "./CatalogItemDetail";
import { ProvenanceBadge, SkillStatusDot } from "./ProvenanceBadge";
import { SkillActions } from "./SkillActions";
import { TablePager } from "./TablePager";
import { useCatalogStore } from "./use-catalog-store";
import { useSearchParamState, useUrlWriter } from "./use-url-param";

const STATUS_LABEL: Record<Exclude<SkillsStatusFilter, "all">, string> = {
  published: "Published",
  draft: "Draft",
  archived: "Archived",
};

const CONFLICT_NOTICE =
  "This skill changed since you opened it. We loaded the latest; review it and apply your edit again.";

/** The Panel's id for a skill: what follows `skill:` in its item key. */
function peekIdOf(item: SkillItem): string {
  return parseItemKey(item.key)?.id ?? item.key;
}

function None() {
  return <span className="text-fg-subtle">None</span>;
}

/** What the Panel shows. Remembered while it animates closed, so the exit never flashes another skill. */
type PanelView =
  | { mode: "create" }
  | { mode: "view" | "edit"; id: string }
  /** A skill just created, shown from the create response until the refreshed list includes it. */
  | { mode: "created"; record: SkillFull };

function samePanelView(a: PanelView | null, b: PanelView | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.mode !== b.mode) return false;
  if (a.mode === "create") return true;
  if (a.mode === "created") return b.mode === "created" && a.record.id === b.record.id;
  return b.mode !== "create" && b.mode !== "created" && a.id === b.id;
}

/**
 * The Skills page: Cloud skills with their status, the skills a runtime
 * registered, and the ones only seen in traces, in one table. A row opens the
 * shared item detail in a Panel; publish and archive sit in a menu on the row
 * and in the Panel. Creating or fully editing a skill keeps the v1 editor,
 * opened in the same Panel (`?new=1`, `?edit=1`), without its searchable
 * description field: that field has one home, the detail.
 */
export function SkillsCatalog({
  projectId,
  projectSlug,
  now,
  data,
}: {
  projectId: string;
  /** The skills create route is addressed by slug. */
  projectSlug: string;
  now: string;
  data: SkillsCatalogData;
}) {
  const store = useCatalogStore({ projectId, skills: data });
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const write = useUrlWriter();
  const view = resolveSkillsView(searchParams);
  const [query, setQuery] = useSearchParamState("q", ["page"]);
  const peek = usePeek();
  const creating = searchParams.get("new") === "1";
  const editing = searchParams.get("edit") === "1";
  const [created, setCreated] = useState<SkillFull | null>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // The editor is the v1 form, which keeps its own state: any input marks it touched,
  // and closing a touched form asks once (a second close discards).
  const [formTouched, setFormTouched] = useState(false);
  const [discardArmed, setDiscardArmed] = useState(false);
  const root = `/project/${encodeURIComponent(projectId)}`;

  const byPeekId = useMemo(
    () => new Map(store.skillItems.map((item) => [peekIdOf(item), item])),
    [store.skillItems],
  );

  // `?skill=<id>` (Suggestions and Adaptive ranking link here) opens that skill, when it is here.
  const legacySkill = searchParams.get("skill");
  const legacyFound = legacySkill !== null && byPeekId.has(legacySkill);
  useEffect(() => {
    if (legacySkill === null) return;
    const search = withQueryParam(window.location.search, "skill", null);
    window.history.replaceState(
      null,
      "",
      `${pathname}${legacyFound ? withQueryParam(search, "peek", legacySkill) : search}`,
    );
  }, [legacySkill, legacyFound, pathname]);

  const filtered = useMemo(
    () =>
      sortSkillItems(
        filterSkillItems(store.skillItems, { query, status: view.status }),
        view.sort,
        view.direction,
      ),
    [store.skillItems, query, view.status, view.sort, view.direction],
  );
  const range = pageWindow(
    filtered.length,
    query === view.query ? parsePage(searchParams.get("page")) : 1,
  );
  const visible = filtered.slice(range.offset, range.end);
  const counts = useMemo(() => {
    const cloud = store.skillItems.filter((item) => item.record !== null);
    return {
      total: store.skillItems.length,
      cloud: cloud.length,
      published: cloud.filter((item) => item.status === "published").length,
      drafts: cloud.filter((item) => item.status === "draft").length,
      runs: store.skillItems.reduce((sum, item) => sum + item.runs, 0),
    };
  }, [store.skillItems]);

  const target = peek.id !== null ? (byPeekId.get(peek.id) ?? null) : null;
  const live: PanelView | null = creating
    ? { mode: "create" }
    : target
      ? { mode: editing && target.record ? "edit" : "view", id: peekIdOf(target) }
      : created && peek.id === created.id
        ? { mode: "created", record: created }
        : null;
  const [lastView, setLastView] = useState<PanelView | null>(live);
  if (live && !samePanelView(live, lastView)) setLastView(live);
  const panel = live ?? lastView;
  const shown =
    panel?.mode === "created"
      ? buildSkillItems({ ...data, skills: [panel.record], runtimeSkills: [] })[0]
      : panel && panel.mode !== "create"
        ? (byPeekId.get(panel.id) ?? null)
        : null;
  const editingRecord = panel?.mode === "edit" ? (shown?.record ?? null) : null;
  const formOpen = panel?.mode === "create" || editingRecord !== null;

  function resetForm() {
    setFormError(null);
    setNameError(null);
    setConflict(false);
    setFormTouched(false);
    setDiscardArmed(false);
  }

  function open(item: SkillItem) {
    resetForm();
    write({ peek: peekIdOf(item), edit: null, new: null });
  }

  function close() {
    resetForm();
    write({ peek: null, edit: null, new: null });
  }

  function requestClose() {
    if (formOpen && formTouched && !discardArmed) {
      setDiscardArmed(true);
      return;
    }
    close();
  }

  function startCreate() {
    resetForm();
    write({ new: "1", peek: null, edit: null });
  }

  function startEdit(item: SkillItem) {
    resetForm();
    write({ peek: peekIdOf(item), edit: "1", new: null });
  }

  function transition(item: SkillItem, next: SkillTransition) {
    void store.transitionSkill(item, next);
  }

  async function submitCreate(body: CreateSkillBody) {
    setPending(true);
    setFormError(null);
    setNameError(null);
    const result = await createSkill(body);
    setPending(false);
    if (result.ok) {
      resetForm();
      setCreated(result.data);
      toast({ title: "Skill created", description: result.data.name, tone: "success" });
      write({ new: null, edit: null, peek: result.data.id });
      router.refresh();
      return;
    }
    if (result.reason === "name_conflict")
      setNameError("A skill with that name already exists in this project.");
    else setFormError(result.error ?? explainMutationError(result.status, result.reason));
  }

  async function submitEdit(record: SkillFull, body: EditSkillBody) {
    setPending(true);
    setFormError(null);
    setNameError(null);
    const result = await editSkill(record.id, body);
    setPending(false);
    if (result.ok) {
      store.applyRecord(result.data);
      resetForm();
      toast({ title: "Skill saved", description: result.data.name, tone: "success" });
      write({ edit: null });
      return;
    }
    if (result.reason === "version_conflict") {
      // Load the latest; the editor remounts on the new version with the notice.
      setConflict(true);
      router.refresh();
      return;
    }
    if (result.reason === "name_conflict")
      setNameError("A skill with that name already exists in this project.");
    else setFormError(explainMutationError(result.status, result.reason));
  }

  const sortHref = (id: SkillsSortKey) => (direction: SortDirection) =>
    `${pathname}${withQueryParams(`?${searchParams.toString()}`, { sort: id, dir: direction, page: null })}`;
  // A plain click sorts in place: the rows are already here, so no loader needs to run again.
  const sortInPlace = (id: SkillsSortKey) => (direction: SortDirection) =>
    write({ sort: id, dir: direction, page: null });

  const columns: readonly Column<SkillItem>[] = [
    {
      id: "name",
      header: "Name",
      sortHref: sortHref("name"),
      onSort: sortInPlace("name"),
      defaultDirection: "asc",
      cell: (item) => (
        <span className="block max-w-72 truncate font-mono text-xs">{item.name}</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      className: "whitespace-nowrap",
      cell: (item) => (item.status ? <SkillStatusDot status={item.status} /> : null),
    },
    {
      id: "searchable",
      header: "Searchable description",
      className: "w-full max-w-0",
      cell: (item) => (
        <span className="block truncate text-fg-muted">
          {item.searchable?.text ?? item.agentDescription ?? <None />}
        </span>
      ),
    },
    {
      id: "runs",
      header: "Runs",
      align: "right",
      sortHref: sortHref("runs"),
      onSort: sortInPlace("runs"),
      cell: (item) => fmtExact(item.runs),
    },
    {
      id: "updated",
      header: "Updated",
      align: "right",
      sortHref: sortHref("updated"),
      onSort: sortInPlace("updated"),
      className: "whitespace-nowrap",
      cell: (item) => {
        const at = skillUpdatedAt(item);
        return at ? (
          <Tooltip content={fmtDateTime(at)}>
            <time dateTime={at}>{fmtRelative(at, now)}</time>
          </Tooltip>
        ) : (
          <span className="text-fg-subtle">Never</span>
        );
      },
    },
    {
      id: "source",
      header: "Source",
      cell: (item) => <ProvenanceBadge provenance={item.provenance} />,
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      cell: (item) => <SkillActions item={item} onTransition={transition} onEdit={startEdit} />,
    },
  ];

  const openIndex = visible.findIndex((item) => peekIdOf(item) === peek.id);
  const step = (direction: 1 | -1) => {
    const next = visible[stepIndex(openIndex, direction, visible.length)];
    if (next) open(next);
  };
  const narrowed = query.trim() !== "" || view.status !== "all";
  const newSkill = (
    <Button variant="primary" onClick={startCreate}>
      <Plus aria-hidden strokeWidth={1.5} />
      New skill
    </Button>
  );

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Catalog", href: `${root}/catalogs` }]}
        title="Skills"
        actions={
          <>
            <Link href={`${root}/playground`} className={buttonVariants({ variant: "secondary" })}>
              Test a search
            </Link>
            {newSkill}
          </>
        }
      />
      <PageBody wide>
        {counts.total === 0 ? (
          <EmptyState
            emblem
            title="No skills yet"
            description="A skill is a set of instructions your agent can find and follow when a request calls for it."
            action={newSkill}
          />
        ) : (
          <>
            <StatRow
              stats={[
                {
                  label: "Published",
                  value: fmtExact(counts.published),
                  hint: `of ${fmtExact(counts.cloud)} created here`,
                },
                { label: "Drafts", value: fmtExact(counts.drafts) },
                { label: "Runs", value: fmtCompact(counts.runs) },
              ]}
            />
            <section aria-label="Skills" className="flex scroll-mt-16 flex-col gap-3">
              <FilterBar
                search={
                  <SearchInput
                    value={query}
                    onValueChange={setQuery}
                    placeholder="Search skills…"
                    label="Search skills"
                  />
                }
                chips={
                  view.status !== "all" ? (
                    <FilterChip
                      field="Status is"
                      value={STATUS_LABEL[view.status]}
                      onRemove={() => write({ status: null, page: null })}
                    />
                  ) : null
                }
                addFilter={
                  <Menu>
                    <MenuTrigger render={<Button size="sm" variant="ghost" />}>
                      <Filter aria-hidden strokeWidth={1.5} />
                      Filter
                    </MenuTrigger>
                    <MenuContent>
                      <MenuGroup label="Status">
                        {(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map(
                          (status) => (
                            <MenuItem key={status} onClick={() => write({ status, page: null })}>
                              {STATUS_LABEL[status]}
                            </MenuItem>
                          ),
                        )}
                      </MenuGroup>
                    </MenuContent>
                  </Menu>
                }
                end={
                  <span className="text-xs text-fg-subtle tabular-nums">
                    {narrowed
                      ? `${fmtExact(filtered.length)} of ${plural(counts.total, "skill")}`
                      : plural(counts.total, "skill")}
                  </span>
                }
              />
              <DataTable
                caption="Skills"
                columns={columns}
                rows={visible}
                rowKey={peekIdOf}
                sort={{ id: view.sort, direction: view.direction }}
                selectedKey={peek.id}
                onRowOpen={open}
                empty={
                  <EmptyState
                    icon={SearchX}
                    title="No skills match"
                    description="Clear the search or the filter to see every skill."
                    action={
                      <Button
                        size="sm"
                        onClick={() => {
                          setQuery("");
                          write({ status: null, page: null });
                        }}
                      >
                        Clear filters
                      </Button>
                    }
                  />
                }
              />
              <TablePager
                window={range}
                total={filtered.length}
                onPage={(page) => write({ page: page === 1 ? null : String(page) })}
              />
            </section>
          </>
        )}
      </PageBody>

      <Panel
        open={live !== null}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
        title={
          panel?.mode === "create" ? (
            "New skill"
          ) : (
            <span className="font-mono">{shown?.name ?? ""}</span>
          )
        }
        subtitle={
          panel?.mode === "create"
            ? "Instructions your agent can find and follow."
            : editingRecord
              ? "Editing"
              : undefined
        }
        actions={
          shown && !formOpen ? (
            <>
              {panel?.mode === "view" ? (
                <Link
                  href={`${root}/catalogs${withItemParam("", itemKey("skill", peekIdOf(shown)))}`}
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  Show in catalog
                </Link>
              ) : null}
              <SkillActions item={shown} onTransition={transition} onEdit={startEdit} />
            </>
          ) : null
        }
        // Stepping away from an open form would drop it.
        onPrevious={panel?.mode === "view" ? () => step(-1) : undefined}
        onNext={panel?.mode === "view" ? () => step(1) : undefined}
      >
        {discardArmed ? (
          <Callout
            tone="warning"
            title="You have unsaved changes"
            className="mb-4"
            action={
              <Button size="sm" onClick={() => setDiscardArmed(false)}>
                Keep editing
              </Button>
            }
          >
            Close the panel again to discard them.
          </Callout>
        ) : null}
        {formError ? (
          <Callout tone="danger" title="Couldn't save the skill" className="mb-4">
            {formError}
          </Callout>
        ) : null}
        {formOpen ? (
          <div
            onInput={() => {
              setFormTouched(true);
              setDiscardArmed(false);
            }}
          >
            <SkillEditor
              key={editingRecord ? `${editingRecord.id}:${editingRecord.version}` : "create"}
              mode={editingRecord ? "edit" : "create"}
              skill={editingRecord ?? undefined}
              projectSlug={projectSlug}
              pending={pending}
              notice={editingRecord && conflict ? CONFLICT_NOTICE : null}
              serverNameError={nameError}
              // The searchable description is edited in the detail, its one home.
              searchableDescriptionEnabled={false}
              catalogAdopted={data.adopted}
              onCancel={() => {
                resetForm();
                if (editingRecord) write({ edit: null });
                else close();
              }}
              onSubmitCreate={(body) => void submitCreate(body)}
              onSubmitEdit={(body) =>
                editingRecord ? void submitEdit(editingRecord, body) : undefined
              }
            />
          </div>
        ) : shown ? (
          <CatalogItemDetail
            item={shown}
            now={now}
            layout="panel"
            adopted={{ tool: null, skill: data.adopted }}
            onSaveSearchable={store.saveSearchable}
            onResetSearchable={store.resetSearchable}
            draft={store.drafts.get(shown.key) ?? null}
            onDraftChange={(item, draft) => store.setDraft(item.key, draft)}
          />
        ) : null}
      </Panel>
    </>
  );
}
