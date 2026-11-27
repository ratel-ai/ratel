"use client";

import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { changeAlertAction } from "@/app/(console)/project/[projectId]/alerts/actions";
import { formatTimestamp, MISSING } from "@/lib/synthesis/traces/v2/format";
import { conditionText, measuredText, unitOf, WINDOW_LABELS } from "@/lib/views/alerts/format";
import { alertsHref } from "@/lib/views/alerts/links";
import type { AlertEvent } from "@/lib/views/alerts/store";
import { RelativeTime } from "../traces/cells";
import { type AlertItem, PauseSwitch, RuleState, StateBadge } from "./parts";

export type AlertEventItem = Omit<AlertEvent, "at"> & { at: string };

/** One alert: its state, its form (`children`) and each state change. */
export function AlertDetail({
  projectId,
  alert,
  events,
  now,
  children,
}: {
  projectId: string;
  alert: AlertItem;
  events: readonly AlertEventItem[];
  now: string;
  children: ReactNode;
}) {
  const unit = unitOf(alert.query);
  const columns: Column<AlertEventItem>[] = [
    {
      id: "at",
      header: "When",
      width: "9rem",
      cell: (row) => (
        <span title={formatTimestamp(row.at)}>
          <RelativeTime value={row.at} now={now} />
        </span>
      ),
    },
    {
      id: "state",
      header: "State",
      width: "7rem",
      cell: (row) => <StateBadge state={row.toState} />,
    },
    {
      id: "value",
      header: "Value",
      align: "right",
      width: "6rem",
      cell: (row) => (row.value === null ? MISSING : measuredText(row.value, unit)),
    },
    {
      id: "condition",
      header: "Condition",
      width: "14rem",
      hiddenBelow: "md",
      cell: (row) => (
        <span className="whitespace-nowrap text-fg-muted">
          {`${row.operator} ${measuredText(row.threshold, unit)} over ${WINDOW_LABELS[row.windowMinutes]}`}
        </span>
      ),
    },
    {
      id: "message",
      header: "Message",
      className: "w-full",
      cell: (row) => <span className="text-fg-muted">{messageText(row)}</span>,
    },
  ];
  return (
    <Page>
      <PageHeader
        crumbs={[{ label: "Alerts", href: alertsHref(projectId) }]}
        title={alert.name}
        description={conditionText(alert, alert)}
        actions={
          <>
            <RuleState alert={alert} />
            <PauseSwitch projectId={projectId} alert={alert} label="On" />
            <DeleteAlert projectId={projectId} alert={alert} />
          </>
        }
      />
      <PageBody wide>
        {alert.problem ? (
          <Callout tone="warning" title="This alert needs attention">
            {`${alert.problem} It is not checked. Pick what it measures and save it.`}
          </Callout>
        ) : alert.lastError ? (
          <Callout tone="danger" title="This alert is failing">
            {`${alert.lastError} It does not fire until its query reads again.`}
          </Callout>
        ) : null}
        {children}
        <Section title="History" description="Each change of the state, newest first.">
          <DataTable
            caption="History"
            columns={columns}
            rows={events}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                emblem
                title="No change yet"
                description="The first check is in about a minute."
              />
            }
          />
        </Section>
      </PageBody>
    </Page>
  );
}

function messageText(event: AlertEventItem): string {
  if (!event.notice) return MISSING;
  const name = event.notice === "fire" ? "Alert" : "Recovery";
  if (event.delivery === "failed") return `${name} not sent. ${event.error ?? ""}`;
  if (event.delivery === "pending")
    return event.attempts === 0
      ? `${name} is being sent`
      : `${name} is tried again. ${event.error ?? ""}`;
  return event.sentTo.length === 0 ? `${name}, no destination` : `${name} sent`;
}

function DeleteAlert({
  projectId,
  alert,
}: {
  projectId: string;
  alert: Pick<AlertItem, "id" | "name">;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function remove() {
    const result = await changeAlertAction({ projectId, action: "delete", ruleId: alert.id });
    if (!result.ok) {
      toast({ title: result.error, tone: "danger" });
      return;
    }
    toast({ title: `Deleted ${alert.name}` });
    router.push(alertsHref(projectId));
  }

  return (
    <>
      <Button className="text-danger" onClick={() => setOpen(true)}>
        Delete…
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${alert.name}?`}
        description="The alert and its history are deleted for good."
        confirmLabel="Delete alert"
        requireText={alert.name}
        onConfirm={remove}
      />
    </>
  );
}
