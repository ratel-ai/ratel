"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Menu, MenuContent, MenuLinkItem, MenuTrigger } from "@ratel/design-system/menu";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { StatRow } from "@ratel/design-system/stat-row";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { changeScorerAction } from "@/app/(console)/project/[projectId]/scorers/actions";
import { formatInteger, formatPercent, MISSING, shortId } from "@/lib/synthesis/traces/v2/format";
import { addScorerHref, dashboardsHref } from "@/lib/views/dashboards/links";
import { KIND_LABELS } from "@/lib/views/scorers/format";
import { scorersHref, traceHref } from "@/lib/views/scorers/paths";
import type { TraceScore } from "@/lib/views/scorers/types";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";
import { RelativeTime } from "../traces/cells";
import { EnabledSwitch, type ScorerItem, ScoreValue, summaryValue, tasksLabel } from "./parts";
import { ScoreTrend, type TrendDay } from "./ScoreTrend";

export interface LatestRow extends TraceScore {
  traceId: string;
  traceStartedAt: string;
  scoredAt: string;
}

/** One scorer: its numbers, its trend, and its latest results, each a link to the trace. */
export function ScorerDetail({
  projectId,
  dashboards,
  scorer,
  trend,
  latest,
  now,
}: {
  projectId: string;
  /** The project's dashboards; null with `customMonitoring` off. */
  dashboards: readonly { id: string; name: string }[] | null;
  scorer: ScorerItem;
  trend: readonly TrendDay[];
  latest: readonly LatestRow[];
  now: string;
}) {
  const router = useRouter();
  const root = scorersHref(projectId);
  const columns: Column<LatestRow>[] = [
    {
      id: "trace",
      header: "Trace",
      className: "w-full",
      cell: (row) => (
        <Link
          href={traceHref(projectId, row.traceId)}
          className="whitespace-nowrap font-mono text-xs text-fg hover:underline"
        >
          {shortId(row.traceId)}
        </Link>
      ),
    },
    { id: "result", header: "Result", width: "8rem", cell: (row) => <ScoreValue score={row} /> },
    ...(scorer.kind === "judge"
      ? [
          {
            id: "confidence",
            header: "Confidence",
            align: "right" as const,
            width: "7rem",
            hiddenBelow: "sm" as const,
            cell: (row: LatestRow) =>
              row.confidence === null ? MISSING : formatPercent(row.confidence),
          },
        ]
      : []),
    {
      id: "started",
      header: "Started",
      align: "right",
      width: "8rem",
      cell: (row) => <RelativeTime value={row.traceStartedAt} now={now} />,
    },
  ];
  return (
    <Page>
      <PageHeader
        crumbs={[{ label: "Scorers", href: root }]}
        title={scorer.name}
        description={scorer.summary}
        actions={
          <>
            <EnabledSwitch projectId={projectId} scorer={scorer} label="On" />
            <AddToDashboard projectId={projectId} scorerId={scorer.id} dashboards={dashboards} />
            <Link
              href={`${root}/${scorer.id}/edit`}
              className={buttonVariants({ variant: "secondary" })}
            >
              Edit
            </Link>
            <DeleteScorer projectId={projectId} scorer={scorer} />
          </>
        }
      />
      <PageBody wide>
        <StatRow
          stats={[
            {
              label: scorer.verdict ? "Pass rate, 7 days" : "Average, 7 days",
              value: summaryValue(scorer),
            },
            { label: "Traces scored, 7 days", value: formatInteger(scorer.week?.scored ?? 0) },
            { label: "Sample", value: `${scorer.sampleRate}%` },
            { label: "Kind", value: KIND_LABELS[scorer.kind] },
            {
              label: "Tasks",
              value: scorer.tasks?.length
                ? formatInteger(scorer.tasks.length)
                : tasksLabel(scorer.tasks),
            },
          ]}
        />
        <Section title={scorer.verdict ? "Pass rate by day" : "Average by day"}>
          <ScoreTrend days={trend} verdict={scorer.verdict} />
        </Section>
        {scorer.tasks?.length ? (
          <Section title="Tasks">
            <ul className="flex flex-col gap-1 text-sm">
              {scorer.tasks.map((task) => (
                <li key={task.id}>
                  <Link
                    href={topLevelTasksHref(projectId, task.id)}
                    className="text-fg hover:underline"
                  >
                    {task.name}
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        <Section title="Latest results">
          <DataTable
            caption="Latest results"
            columns={columns}
            rows={latest}
            rowKey={(row) => row.traceId}
            onRowOpen={(row) => router.push(traceHref(projectId, row.traceId))}
            empty={
              <EmptyState
                emblem
                title="No results yet"
                description={
                  !scorer.enabled
                    ? "This scorer is off. Turn it on to score new traces."
                    : scorer.tasks === null
                      ? "New matching traces get a result about two minutes after their last span."
                      : scorer.tasks.length === 0
                        ? "This scorer has no task. Attach it to a task to score its new traces."
                        : "New traces of its tasks get a result after the next Agent health reading, which runs once a day."
                }
              />
            }
          />
        </Section>
      </PageBody>
    </Page>
  );
}

/** To a dashboard, with the editor open on this scorer. Without one, to where it is created. */
function AddToDashboard({
  projectId,
  scorerId,
  dashboards,
}: {
  projectId: string;
  scorerId: string;
  dashboards: readonly { id: string; name: string }[] | null;
}) {
  if (!dashboards) return null;
  if (dashboards.length === 0)
    return (
      <Link href={dashboardsHref(projectId)} className={buttonVariants({ variant: "secondary" })}>
        Add to dashboard
      </Link>
    );
  return (
    <Menu>
      <MenuTrigger render={<Button variant="secondary" />}>Add to dashboard</MenuTrigger>
      <MenuContent align="end">
        {dashboards.map(({ id, name }) => (
          <MenuLinkItem key={id} render={<Link href={addScorerHref(projectId, id, scorerId)} />}>
            {name}
          </MenuLinkItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function DeleteScorer({
  projectId,
  scorer,
}: {
  projectId: string;
  scorer: Pick<ScorerItem, "id" | "name">;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function remove() {
    const result = await changeScorerAction({ projectId, action: "delete", scorerId: scorer.id });
    if (!result.ok) {
      toast({
        title: "Couldn't delete the scorer",
        description: result.error,
        tone: "danger",
      });
      return;
    }
    toast({ title: `Deleted ${scorer.name}` });
    router.push(scorersHref(projectId));
  }

  return (
    <>
      <Button className="text-danger" onClick={() => setOpen(true)}>
        Delete…
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${scorer.name}?`}
        description="The scorer and every result it stored are deleted for good."
        confirmLabel="Delete scorer"
        requireText={scorer.name}
        onConfirm={remove}
      />
    </>
  );
}
