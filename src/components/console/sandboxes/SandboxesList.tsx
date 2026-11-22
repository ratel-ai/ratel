"use client";

import { Badge } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SandboxSummary } from "@/lib/views/sandboxes/page";

/** The sandboxes of the caller's runner. A row opens the sandbox's playground. */
export function SandboxesList({
  projectId,
  sandboxes,
  paused,
}: {
  projectId: string;
  sandboxes: readonly SandboxSummary[];
  paused: boolean;
}) {
  const router = useRouter();
  const href = (sandbox: SandboxSummary) =>
    `/project/${encodeURIComponent(projectId)}/sandboxes/${encodeURIComponent(sandbox.id)}`;
  const columns: Column<SandboxSummary>[] = [
    {
      id: "sandbox",
      header: "Sandbox",
      cell: (sandbox) => (
        <span className="flex min-w-0 items-center gap-3">
          <Link
            href={href(sandbox)}
            className="font-mono text-xs text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {sandbox.id}
          </Link>
          {sandbox.file ? (
            <span className="truncate font-mono text-xs text-fg-subtle max-md:hidden">
              {sandbox.file}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "input",
      header: "Input",
      width: "8rem",
      cell: (sandbox) => <Badge>{sandbox.inputKind === "chat" ? "Chat" : "Structured"}</Badge>,
    },
    {
      id: "params",
      header: "Params",
      width: "6rem",
      align: "right",
      cell: (sandbox) => <span className="tabular-nums text-fg-muted">{sandbox.paramCount}</span>,
    },
  ];
  return (
    <DataTable
      caption={paused ? "Sandboxes of your paused runner" : "Sandboxes of your runner"}
      columns={columns}
      rows={sandboxes}
      rowKey={(sandbox) => sandbox.id}
      onRowOpen={(sandbox) => router.push(href(sandbox))}
      empty={
        <p className="px-4 py-8 text-center text-sm text-fg-muted">
          Your runner has no sandboxes. Add a .sandbox.ts file next to your agent code.
        </p>
      }
    />
  );
}
