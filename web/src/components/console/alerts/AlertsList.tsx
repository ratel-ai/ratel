"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MISSING } from "@/lib/synthesis/traces/v2/format";
import { conditionText } from "@/lib/views/alerts/format";
import { alertHref, newAlertHref } from "@/lib/views/alerts/links";
import { RelativeTime } from "../traces/cells";
import { type AlertItem, PauseSwitch, RuleState } from "./parts";

/** The project's alerts, or the way to the first one. */
export function AlertsList({
  projectId,
  alerts,
  now,
}: {
  projectId: string;
  alerts: readonly AlertItem[];
  now: string;
}) {
  const router = useRouter();
  const create = (
    <Link href={newAlertHref(projectId)} className={buttonVariants({ variant: "primary" })}>
      Create alert
    </Link>
  );
  const columns: Column<AlertItem>[] = [
    {
      id: "name",
      header: "Alert",
      className: "w-full max-w-0 min-w-48",
      cell: (row) => (
        <span className="flex min-w-0 items-baseline gap-2">
          <Link
            href={alertHref(projectId, row.id)}
            className="max-w-1/2 shrink-0 truncate text-fg hover:underline"
          >
            {row.name}
          </Link>
          <span className="min-w-0 truncate text-xs text-fg-subtle">
            {row.problem ?? conditionText(row, row)}
          </span>
        </span>
      ),
    },
    {
      id: "state",
      header: "State",
      width: "9rem",
      cell: (row) => <RuleState alert={row} />,
    },
    {
      id: "changed",
      header: "Last change",
      align: "right",
      width: "8rem",
      hiddenBelow: "sm",
      cell: (row) =>
        row.stateChangedAt ? <RelativeTime value={row.stateChangedAt} now={now} /> : MISSING,
    },
    {
      id: "enabled",
      header: "On",
      width: "4rem",
      cell: (row) => (
        // The row opens the alert; the switch must not.
        // biome-ignore lint/a11y/noStaticElementInteractions: it only stops the row's click.
        // biome-ignore lint/a11y/useKeyWithClickEvents: it only stops the row's click.
        <span onClick={(event) => event.stopPropagation()}>
          <PauseSwitch
            projectId={projectId}
            alert={row}
            label={<span className="sr-only">{`${row.name} is on`}</span>}
          />
        </span>
      ),
    },
  ];
  return (
    <Page>
      <PageHeader
        title="Alerts"
        description="The metrics with a threshold, and whether they cross it now."
        actions={alerts.length > 0 ? create : undefined}
      />
      <PageBody wide>
        {alerts.length === 0 ? (
          <EmptyState
            emblem
            title="No alerts yet"
            description="Pick a metric and a threshold. Ratel checks it every minute."
            action={create}
          />
        ) : (
          <DataTable
            caption="Alerts"
            columns={columns}
            rows={alerts}
            rowKey={(row) => row.id}
            onRowOpen={(row) => router.push(alertHref(projectId, row.id))}
          />
        )}
      </PageBody>
    </Page>
  );
}
