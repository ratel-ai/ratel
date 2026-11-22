"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { LayoutDashboard, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { projectRoot } from "@/lib/console/navigation";
import { createDashboardAction } from "@/lib/views/custom-dashboards/actions";
import { type DashboardSharing, MAX_NAME_LENGTH } from "@/lib/views/custom-dashboards/model";

/**
 * Dashboards (RC-888, flag `cloud-custom-dashboards`): the project's
 * dashboards this member opens, theirs and those shared with the project.
 */

export interface DashboardListItem {
  id: string;
  name: string;
  sharing: DashboardSharing;
  mine: boolean;
  updatedAt: string;
}

export function DashboardList({
  projectId,
  dashboards,
}: {
  projectId: string;
  dashboards: DashboardListItem[];
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const href = (id: string) => `${projectRoot(projectId)}/dashboards/${encodeURIComponent(id)}`;
  const columns: Column<DashboardListItem>[] = [
    {
      id: "name",
      header: "Name",
      cell: (row) => <span className="font-medium text-fg">{row.name}</span>,
    },
    {
      id: "sharing",
      header: "Shared with",
      width: "10rem",
      cell: (row) => (
        <Badge tone={row.sharing === "project" ? "info" : "neutral"}>
          {row.sharing === "project" ? "Project" : "Only you"}
        </Badge>
      ),
    },
    {
      id: "owner",
      header: "Owner",
      width: "8rem",
      hiddenBelow: "sm",
      cell: (row) => (row.mine ? "You" : "A teammate"),
    },
    {
      id: "updated",
      header: "Updated",
      width: "10rem",
      align: "right",
      hiddenBelow: "md",
      cell: (row) => (
        <time dateTime={row.updatedAt}>
          {new Date(row.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </time>
      ),
    },
  ];
  const createButton = (
    <Button variant="primary" onClick={() => setCreating(true)}>
      <Plus aria-hidden className="size-4" />
      Create dashboard
    </Button>
  );

  return (
    <Page>
      <PageHeader title="Dashboards" actions={createButton} />
      <PageBody>
        <DataTable
          caption="Dashboards"
          columns={columns}
          rows={dashboards}
          rowKey={(row) => row.id}
          onRowOpen={(row) => router.push(href(row.id))}
          empty={
            <EmptyState
              icon={LayoutDashboard}
              title="No dashboards yet"
              description="Build one from your runs, grouped by model, tool or a pivot, and share it with the project."
              action={createButton}
            />
          }
        />
      </PageBody>
      <CreateDashboardDialog
        open={creating}
        onOpenChange={setCreating}
        projectId={projectId}
        onCreated={(id) => router.push(href(id))}
      />
    </Page>
  );
}

function CreateDashboardDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createDashboardAction(projectId, name);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({ title: "Dashboard created", tone: "success" });
      onOpenChange(false);
      setName("");
      onCreated(result.dashboardId);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Create dashboard"
        footer={
          <>
            <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
            <Button type="submit" form="create-dashboard" variant="primary" loading={pending}>
              Create dashboard
            </Button>
          </>
        }
      >
        <form id="create-dashboard" onSubmit={submit}>
          <Field label="Name" error={error ?? undefined}>
            {(props) => (
              <Input
                {...props}
                autoComplete="off"
                maxLength={MAX_NAME_LENGTH}
                placeholder="Costs by client"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
              />
            )}
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}
