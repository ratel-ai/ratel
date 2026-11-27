"use client";

import { Badge } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { ListChecks } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { CaseRow, ExperimentRow, ReadyVersion } from "@/lib/views/evals/page-model";
import { caseHref } from "@/lib/views/evals/paths";
import { ExperimentList } from "./ExperimentList";
import { RunEvals } from "./RunEvals";

/** The experiments and the cases of a project. */
export function EvalsView({
  projectId,
  canEdit,
  cases,
  experiments,
  baselineId,
  versions,
  now,
  children,
}: {
  projectId: string;
  canEdit: boolean;
  cases: CaseRow[];
  experiments: ExperimentRow[];
  baselineId: string | null;
  versions: ReadyVersion[];
  /** ISO time the page was rendered, so relative times agree on server and client. */
  now: string;
  /** What the edition adds at the foot. */
  children?: ReactNode;
}) {
  return (
    <Page>
      <PageHeader
        title="Evals"
        description="A case is one input for your agent and the checks of its answer. An approved case does not change."
        actions={
          canEdit ? (
            <Link
              href={caseHref(projectId, "new")}
              className={buttonVariants({ variant: "secondary" })}
            >
              New case
            </Link>
          ) : null
        }
      />
      <PageBody>
        {canEdit ? (
          <RunEvals
            projectId={projectId}
            versions={versions}
            approved={cases.filter(({ approved }) => approved !== null).length}
          />
        ) : null}
        <ExperimentList
          projectId={projectId}
          experiments={experiments}
          baselineId={baselineId}
          now={now}
        />
        <Section title="Cases" description="Only an approved case counts in an eval run.">
          {cases.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="No case yet"
              description="Open a turn in Traces and save it as an eval case, or make a new one."
            />
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-raised">
              {cases.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <Link
                    href={caseHref(projectId, row.id)}
                    className="min-w-0 truncate text-ui font-medium text-fg underline-offset-2 hover:underline"
                  >
                    {row.name}
                  </Link>
                  {row.approved !== null ? (
                    <Badge tone="success">Approved v{row.approved}</Badge>
                  ) : null}
                  {row.draft !== null ? <Badge tone="neutral">Draft v{row.draft}</Badge> : null}
                  {row.labels.map((label) => (
                    <span key={label} className="text-xs text-fg-subtle">
                      {label}
                    </span>
                  ))}
                  <span className="ml-auto text-xs text-fg-subtle" title={row.createdAt}>
                    {formatRelativeTime(row.createdAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        {children}
      </PageBody>
    </Page>
  );
}
