"use client";

import { Badge } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { Box } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { SandboxListModel, SandboxListRow } from "@/lib/views/sandboxes/page-model";
import { NewSandboxDialog } from "./NewSandboxDialog";
import { ProjectSecrets } from "./SandboxSecrets";
import { ProblemsCallout, VERSION_STATUS } from "./sandbox-status";

/** The Sandboxes page: one row a sandbox, the "New sandbox" dialog, and the project secrets. */
export function SandboxesList({
  model,
  projectName,
  ratelUrl,
  now,
}: {
  model: SandboxListModel;
  projectName: string;
  /** The public address of this server. */
  ratelUrl: string;
  /** ISO time the page was rendered, so relative times agree on server and client. */
  now: string;
}) {
  const router = useRouter();
  const columns: Column<SandboxListRow>[] = [
    {
      id: "name",
      header: "Name",
      cell: (row) => (
        <Link href={row.href} className="font-medium text-fg hover:underline">
          {row.name}
        </Link>
      ),
    },
    {
      id: "newest",
      header: "Newest version",
      width: "18rem",
      cell: (row) => (
        <span className="inline-flex items-center gap-2">
          <Badge tone={VERSION_STATUS[row.newest.status].tone}>
            {VERSION_STATUS[row.newest.status].label}
          </Badge>
          <code className="font-mono text-xs text-fg-muted">
            {row.newest.commit?.slice(0, 12) ?? row.newest.id.slice(0, 8)}
          </code>
          <span className="text-xs text-fg-subtle">
            {row.versions === 1 ? "1 version" : `${row.versions} versions`}
          </span>
        </span>
      ),
    },
    {
      id: "push",
      header: "Last push",
      width: "9rem",
      hiddenBelow: "sm",
      cell: (row) => (
        <span className="text-fg-muted" title={row.lastPushAt}>
          {formatRelativeTime(row.lastPushAt, now)}
        </span>
      ),
    },
    {
      id: "run",
      header: "Last run",
      width: "9rem",
      hiddenBelow: "md",
      cell: (row) =>
        row.lastRunAt ? (
          <span className="text-fg-muted" title={row.lastRunAt}>
            {formatRelativeTime(row.lastRunAt, now)}
          </span>
        ) : (
          <span className="text-fg-faint">No run yet</span>
        ),
    },
  ];
  return (
    <Page>
      <PageHeader
        title="Sandboxes"
        description="The agents you pushed. Open one to try it in its Playground."
        actions={
          <NewSandboxDialog
            projectId={model.projectId}
            projectName={projectName}
            ratelUrl={ratelUrl}
          />
        }
      />
      <PageBody>
        <ProblemsCallout model={model} />
        <DataTable
          caption="Sandboxes"
          columns={columns}
          rows={model.sandboxes}
          rowKey={(row) => row.name}
          onRowOpen={(row) => router.push(row.href)}
          empty={
            <EmptyState
              icon={Box}
              title="No sandbox yet"
              description="Push your agent with ratel push. New sandbox shows the three steps."
            />
          }
        />
        <ProjectSecrets
          projectId={model.projectId}
          secrets={model.projectSecrets}
          canEdit={model.canEdit}
          now={now}
        />
      </PageBody>
    </Page>
  );
}
