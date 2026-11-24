"use client";

import { Button } from "@ratel/design-system/button";
import { DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { LayoutDashboard, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatInteger, formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import { dashboardHref } from "@/lib/views/dashboards/links";
import { NameDialog } from "./NameDialog";
import { useDashboardAction } from "./use-dashboard-action";

export interface DashboardRow {
  id: string;
  name: string;
  widgets: number;
  updatedAt: string;
}

/** The project's dashboards. Creating one opens it. */
export function DashboardsListView({
  projectId,
  now,
  dashboards,
}: {
  projectId: string;
  now: string;
  dashboards: readonly DashboardRow[];
}) {
  const router = useRouter();
  const { change, saving } = useDashboardAction(projectId);
  const [naming, setNaming] = useState(false);

  async function create(input: { action: "create"; name: string } | { action: "create-starter" }) {
    const id = await change(input);
    if (!id) return;
    setNaming(false);
    router.push(dashboardHref(projectId, id));
  }

  return (
    <Page>
      <PageHeader
        title="Dashboards"
        actions={
          dashboards.length > 0 ? (
            <Button variant="primary" size="sm" onClick={() => setNaming(true)}>
              <Plus className="size-3.5" aria-hidden />
              Create dashboard
            </Button>
          ) : null
        }
      />
      <PageBody>
        {dashboards.length === 0 ? (
          <EmptyState
            icon={LayoutDashboard}
            title="No dashboards yet"
            description="Put the metrics you check every day on one page."
            action={
              <Button variant="primary" onClick={() => setNaming(true)}>
                Create dashboard
              </Button>
            }
            secondary={
              <Button
                variant="secondary"
                loading={saving && !naming}
                onClick={() => void create({ action: "create-starter" })}
              >
                Start from the traces overview
              </Button>
            }
          />
        ) : (
          <DataTable
            caption="Dashboards"
            rows={dashboards}
            rowKey={(row) => row.id}
            onRowOpen={(row) => router.push(dashboardHref(projectId, row.id))}
            columns={[
              {
                id: "name",
                header: "Name",
                cell: (row) => (
                  <Link
                    href={dashboardHref(projectId, row.id)}
                    className="font-medium text-fg hover:underline"
                  >
                    {row.name}
                  </Link>
                ),
              },
              {
                id: "widgets",
                header: "Widgets",
                align: "right",
                width: "8rem",
                cell: (row) => formatInteger(row.widgets),
              },
              {
                id: "updated",
                header: "Changed",
                align: "right",
                width: "10rem",
                cell: (row) => (
                  <time dateTime={row.updatedAt} title={row.updatedAt}>
                    {formatRelativeTime(row.updatedAt, now)}
                  </time>
                ),
              },
            ]}
          />
        )}
      </PageBody>
      <NameDialog
        open={naming}
        onOpenChange={setNaming}
        title="Create dashboard"
        submitLabel="Create dashboard"
        saving={saving}
        onSubmit={(name) => void create({ action: "create", name })}
      />
    </Page>
  );
}
