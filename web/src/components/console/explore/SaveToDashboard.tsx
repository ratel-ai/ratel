"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useDashboardAction } from "@/components/console/dashboards/use-dashboard-action";
import { takesPageFilters, withPageFilters } from "@/lib/views/dashboards/filters";
import { dashboardHref } from "@/lib/views/dashboards/links";
import {
  type DashboardFilters,
  MAX_DASHBOARD_NAME,
  type WidgetInput,
} from "@/lib/views/dashboards/types";
import { widgetName } from "@/lib/views/dashboards/widget";

export interface DashboardOption {
  id: string;
  name: string;
}

const NEW = "new";

/** Add a panel to a dashboard of the project, or to a new one. */
export function SaveToDashboard({
  open,
  onOpenChange,
  projectId,
  widget: panel,
  filters,
  dashboards,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  widget: WidgetInput;
  /** The page's: they become part of the widget's own. */
  filters: DashboardFilters;
  dashboards: readonly DashboardOption[];
}) {
  const router = useRouter();
  const formId = useId();
  const widget = { ...panel, query: withPageFilters(panel.query, filters) };
  const included = takesPageFilters(panel.query, filters);
  const { change, saving } = useDashboardAction(projectId);
  // The page's list may come later than the next save.
  const [created, setCreated] = useState<readonly DashboardOption[]>([]);
  const [last, setLast] = useState<string | null>(null);
  const known = new Set(dashboards.map(({ id }) => id));
  const options = [...created.filter(({ id }) => !known.has(id)), ...dashboards];

  async function save(target: string, name: string) {
    const dashboardId = target === NEW ? await change({ action: "create", name }) : target;
    if (!dashboardId) return;
    if (target === NEW) setCreated((current) => [{ id: dashboardId, name }, ...current]);
    setLast(dashboardId);
    if (!(await change({ action: "add-widget", dashboardId, widget }))) return;
    onOpenChange(false);
    toast({
      title: `${widgetName(widget)} saved${included ? " with the page's filters" : ""}`,
      tone: "success",
      action: {
        label: "Open dashboard",
        onClick: () => router.push(dashboardHref(projectId, dashboardId)),
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Save to dashboard"
        description={`${widgetName(widget)} becomes a widget. ${included ? "It includes the filters of this page. " : ""}The time range is the dashboard's.`}
        footer={
          <>
            <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
            <Button type="submit" form={formId} variant="primary" loading={saving}>
              Save
            </Button>
          </>
        }
      >
        <SaveForm id={formId} dashboards={options} last={last} onSubmit={save} />
      </DialogContent>
    </Dialog>
  );
}

/** Inside the popup, so every open starts fresh. */
function SaveForm({
  id,
  dashboards,
  last,
  onSubmit,
}: {
  id: string;
  dashboards: readonly DashboardOption[];
  /** Where the last panel went. */
  last: string | null;
  onSubmit: (target: string, name: string) => void;
}) {
  const [target, setTarget] = useState(last ?? dashboards[0]?.id ?? NEW);
  const [name, setName] = useState("");
  return (
    <form
      id={id}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(target, name);
      }}
    >
      <Field label="Dashboard">
        {(control) => (
          <Select
            {...control}
            className="w-full"
            options={[
              ...dashboards.map((dashboard) => ({ value: dashboard.id, label: dashboard.name })),
              { value: NEW, label: "New dashboard" },
            ]}
            value={target}
            onValueChange={(value) => setTarget(String(value))}
          />
        )}
      </Field>
      {target === NEW ? (
        <Field label="Name">
          {(control) => (
            <Input
              {...control}
              value={name}
              required
              maxLength={MAX_DASHBOARD_NAME}
              autoComplete="off"
              placeholder="Support agent"
              onChange={(event) => setName(event.currentTarget.value)}
            />
          )}
        </Field>
      ) : null}
    </form>
  );
}
