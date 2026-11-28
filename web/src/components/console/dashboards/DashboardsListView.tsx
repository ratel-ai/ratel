"use client";

import { Button } from "@ratel/design-system/button";
import { DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { LayoutDashboard, Plus, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatInteger, formatRelativeTime, MISSING } from "@/lib/synthesis/traces/v2/format";
import { BUILT_BY_ASK_PARAM } from "@/lib/views/ask/outcome";
import { dashboardHref } from "@/lib/views/dashboards/links";
import type { TemplateCard } from "@/lib/views/dashboards/templates/types";
import { CreateDashboardDialog } from "./CreateDashboardDialog";
import { ImportDialog } from "./ImportDialog";
import { useDashboardAction } from "./use-dashboard-action";

export interface DashboardRow {
  id: string;
  name: string;
  widgets: number;
  updatedAt: string;
  updatedBy: string | null;
}

/** The project's dashboards. Creating one opens it. */
export function DashboardsListView({
  projectId,
  now,
  dashboards,
  ask = false,
  templates = [],
  properties = [],
}: {
  projectId: string;
  now: string;
  dashboards: readonly DashboardRow[];
  /** This deployment can draft widgets from words: Create dashboard can build one. */
  ask?: boolean;
  /** The template gallery of Create dashboard, with whether the project has each one's data. */
  templates?: readonly TemplateCard[];
  /** The project's indexed trace properties, for the template By customer. */
  properties?: readonly string[];
}) {
  const router = useRouter();
  const { change, saving } = useDashboardAction(projectId);
  const [naming, setNaming] = useState(false);
  const [importing, setImporting] = useState(false);

  async function create(
    input:
      | { action: "create"; name: string }
      | { action: "create-starter" }
      | { action: "create-template"; template: string; property?: string },
  ): Promise<boolean> {
    const id = await change(input);
    if (!id) return false;
    setNaming(false);
    router.push(dashboardHref(projectId, id));
    return true;
  }

  const importButton = (
    <Button variant="secondary" size="sm" onClick={() => setImporting(true)}>
      <Upload className="size-3.5" aria-hidden />
      Import
    </Button>
  );

  return (
    <Page>
      <PageHeader
        title="Dashboards"
        actions={
          dashboards.length > 0 ? (
            <>
              {importButton}
              <Button variant="primary" size="sm" onClick={() => setNaming(true)}>
                <Plus className="size-3.5" aria-hidden />
                Create dashboard
              </Button>
            </>
          ) : (
            importButton
          )
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
                header: "Last change",
                align: "right",
                width: "10rem",
                cell: (row) => (
                  <time dateTime={row.updatedAt} title={row.updatedAt}>
                    {formatRelativeTime(row.updatedAt, now)}
                  </time>
                ),
              },
              {
                id: "by",
                header: "Changed by",
                width: "14rem",
                className: "truncate",
                cell: (row) => row.updatedBy ?? MISSING,
              },
            ]}
          />
        )}
      </PageBody>
      <CreateDashboardDialog
        open={naming}
        onOpenChange={setNaming}
        projectId={projectId}
        ask={ask}
        saving={saving}
        onCreateBlank={(name) => void create({ action: "create", name })}
        templates={templates}
        properties={properties}
        onCreateTemplate={(template, property) =>
          create({ action: "create-template", template, ...(property ? { property } : {}) })
        }
        onBuilt={(id, askId) =>
          router.push(
            `${dashboardHref(projectId, id)}?${new URLSearchParams({ [BUILT_BY_ASK_PARAM]: askId })}`,
          )
        }
      />
      <ImportDialog
        open={importing}
        onOpenChange={setImporting}
        projectId={projectId}
        onImported={(id) => {
          setImporting(false);
          router.push(dashboardHref(projectId, id));
        }}
      />
    </Page>
  );
}
