"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Section } from "@ratel/design-system/section";
import type { Workspace } from "@/lib/contracts/workspace";

export type WorkspaceCardProps = {
  workspace: Workspace;
  workspaces: Workspace[];
};

export function WorkspaceCard({ workspace, workspaces }: WorkspaceCardProps) {
  const columns: Column<Workspace>[] = [
    { id: "name", header: "Name", cell: (row) => row.name },
    {
      id: "status",
      header: "Status",
      width: "8rem",
      cell: (row) => (row.id === workspace.id ? <Badge tone="accent">Current</Badge> : null),
    },
  ];

  return (
    <Section
      title="Workspaces"
      description={`${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"} available`}
      actions={
        <>
          <Button>Manage</Button>
          <Button variant="primary">Switch workspace</Button>
        </>
      }
    >
      <DataTable
        caption="Workspaces"
        columns={columns}
        rows={workspaces}
        rowKey={(row) => row.id}
      />
    </Section>
  );
}
