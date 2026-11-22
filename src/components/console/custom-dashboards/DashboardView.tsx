"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { ConfirmDialog, Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ratel/design-system/menu";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import {
  ArrowDown,
  ArrowUp,
  LayoutDashboard,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import { projectRoot } from "@/lib/console/navigation";
import {
  addWidgetAction,
  deleteDashboardAction,
  moveWidgetAction,
  removeWidgetAction,
  renameDashboardAction,
  updateWidgetAction,
} from "@/lib/views/custom-dashboards/actions";
import {
  type DashboardSharing,
  MAX_NAME_LENGTH,
  WIDGET_LIMIT,
} from "@/lib/views/custom-dashboards/model";
import { RANGE_LABELS, widgetTitle } from "@/lib/views/custom-dashboards/present";
import type { WidgetSpec } from "@/lib/views/custom-dashboards/spec";
import type { WidgetData } from "@/lib/views/custom-dashboards/widget-data";
import { WidgetBody } from "./WidgetBody";
import { type EditorFacets, type EditorPivot, WidgetEditor } from "./WidgetEditor";

/**
 * One dashboard (RC-888): its widgets in
 * order, each drawn from its own query. A member who may edit it adds, edits,
 * moves and removes widgets, renames it and deletes it.
 */

export interface DashboardViewWidget {
  id: string;
  /** null: the stored spec no longer passes the whitelist; the body says so. */
  spec: WidgetSpec | null;
  data: WidgetData;
}

export interface DashboardViewProps {
  projectId: string;
  dashboard: { id: string; name: string; sharing: DashboardSharing };
  canEdit: boolean;
  widgets: DashboardViewWidget[];
  pivots: EditorPivot[];
  facets: EditorFacets;
  /** RC-889: the sharing controls, drawn in the header. */
  sharingControls?: ReactNode;
}

type Editing = { kind: "add" } | { kind: "edit"; widget: DashboardViewWidget } | null;
type Result = { ok: true } | { ok: false; error: string };

export function DashboardView({
  projectId,
  dashboard,
  canEdit,
  widgets,
  pivots,
  facets,
  sharingControls,
}: DashboardViewProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<Editing>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const full = widgets.length >= WIDGET_LIMIT;
  const listHref = `${projectRoot(projectId)}/dashboards`;

  function run(action: () => Promise<Result>, failure: string, after?: () => void) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        toast({ title: failure, description: result.error, tone: "danger" });
        return;
      }
      after?.();
      router.refresh();
    });
  }

  function saveWidget(spec: WidgetSpec) {
    const current = editing;
    if (!current) return;
    run(
      () =>
        current.kind === "add"
          ? addWidgetAction(projectId, dashboard.id, spec)
          : updateWidgetAction(projectId, dashboard.id, current.widget.id, spec),
      current.kind === "add" ? "Could not add the widget" : "Could not save the widget",
      () => setEditing(null),
    );
  }

  const addButton = canEdit ? (
    <Button
      variant="primary"
      onClick={() => setEditing({ kind: "add" })}
      disabled={full}
      title={full ? `A dashboard has at most ${WIDGET_LIMIT} widgets` : undefined}
    >
      <Plus aria-hidden className="size-4" />
      Add widget
    </Button>
  ) : null;

  const actions = (
    <div className="flex items-center gap-2">
      {sharingControls}
      {canEdit ? (
        <Menu>
          <MenuTrigger
            render={
              <IconButton label="Dashboard actions" icon={<MoreHorizontal />} variant="secondary" />
            }
          />
          <MenuContent align="end">
            <MenuItem icon={<Pencil />} onClick={() => setRenaming(true)}>
              Rename dashboard
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} tone="danger" onClick={() => setDeleting(true)}>
              Delete dashboard
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : null}
      {addButton}
    </div>
  );

  return (
    <Page>
      <PageHeader
        title={dashboard.name}
        crumbs={[{ label: "Dashboards", href: listHref }]}
        actions={actions}
      />
      <PageBody wide>
        {widgets.length === 0 ? (
          <EmptyState
            icon={LayoutDashboard}
            title="No widgets yet"
            description="Add a number, a line, bars or a table over your runs."
            action={addButton}
          />
        ) : (
          <ol className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="Widgets">
            {widgets.map((widget, index) => (
              <WidgetCard
                key={widget.id}
                projectId={projectId}
                widget={widget}
                pivots={pivots}
                canEdit={canEdit}
                first={index === 0}
                last={index === widgets.length - 1}
                onEdit={() => setEditing({ kind: "edit", widget })}
                onMove={(direction) =>
                  run(
                    () => moveWidgetAction(projectId, dashboard.id, widget.id, direction),
                    "Could not move the widget",
                  )
                }
                onRemove={() =>
                  run(
                    () => removeWidgetAction(projectId, dashboard.id, widget.id),
                    "Could not remove the widget",
                    () => toast({ title: "Widget removed", tone: "success" }),
                  )
                }
              />
            ))}
          </ol>
        )}
      </PageBody>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
      >
        {editing ? (
          <WidgetEditor
            key={editing.kind === "edit" ? editing.widget.id : "new"}
            title={editing.kind === "add" ? "Add widget" : "Edit widget"}
            submitLabel={editing.kind === "add" ? "Add widget" : "Save widget"}
            initial={editing.kind === "edit" ? (editing.widget.spec ?? undefined) : undefined}
            pivots={pivots}
            facets={facets}
            pending={pending}
            onSubmit={saveWidget}
          />
        ) : null}
      </Dialog>

      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        name={dashboard.name}
        pending={pending}
        onSubmit={(name) =>
          run(
            () => renameDashboardAction(projectId, dashboard.id, name),
            "Could not rename the dashboard",
            () => setRenaming(false),
          )
        }
      />

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${dashboard.name}?`}
        description={
          dashboard.sharing === "project"
            ? "Its widgets go with it, for every member of the project."
            : "Its widgets go with it."
        }
        confirmLabel="Delete dashboard"
        pending={pending}
        onConfirm={async () => {
          const result = await deleteDashboardAction(projectId, dashboard.id);
          if (!result.ok) throw new Error(result.error);
          setDeleting(false);
          toast({ title: "Dashboard deleted", tone: "success" });
          router.push(listHref);
        }}
      />
    </Page>
  );
}

function WidgetCard({
  projectId,
  widget,
  pivots,
  canEdit,
  first,
  last,
  onEdit,
  onMove,
  onRemove,
}: {
  projectId: string;
  widget: DashboardViewWidget;
  pivots: EditorPivot[];
  canEdit: boolean;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
}) {
  const spec = widget.spec;
  const title = spec ? widgetTitle(spec.metric, spec.groupBy, pivots) : "Widget";
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-lg border border-line p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-sm font-medium text-fg">{title}</h2>
          {spec ? (
            <span className="text-xs text-fg-subtle">{RANGE_LABELS[spec.rangeDays]}</span>
          ) : null}
        </div>
        {canEdit ? (
          <Menu>
            <MenuTrigger
              render={
                <IconButton
                  label={`Actions for ${title}`}
                  icon={<MoreHorizontal />}
                  size="icon-sm"
                />
              }
            />
            <MenuContent align="end">
              <MenuItem icon={<Pencil />} onClick={onEdit}>
                Edit widget
              </MenuItem>
              <MenuItem icon={<ArrowUp />} disabled={first} onClick={() => onMove("up")}>
                Move up
              </MenuItem>
              <MenuItem icon={<ArrowDown />} disabled={last} onClick={() => onMove("down")}>
                Move down
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Trash2 />} tone="danger" onClick={onRemove}>
                Remove widget
              </MenuItem>
            </MenuContent>
          </Menu>
        ) : null}
      </div>
      <WidgetBody
        projectId={projectId}
        metric={spec?.metric ?? "runs"}
        chart={spec?.chart ?? "table"}
        data={widget.data}
      />
    </li>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  name: current,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  pending: boolean;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(current);
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(name);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Rename dashboard"
        footer={
          <>
            <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
            <Button type="submit" form="rename-dashboard" variant="primary" loading={pending}>
              Rename dashboard
            </Button>
          </>
        }
      >
        <form id="rename-dashboard" onSubmit={submit}>
          <Field label="Name">
            {(props) => (
              <Input
                {...props}
                autoComplete="off"
                maxLength={MAX_NAME_LENGTH}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}
