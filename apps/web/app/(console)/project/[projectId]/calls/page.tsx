import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { Activity } from "lucide-react";
import Link from "next/link";
import { TextTable } from "@/components/console/data/TextTable";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { listModelCalls, parseCallsCursor } from "@/lib/console/calls";
import { fmtUtc } from "@/lib/console/format";
import { projectRoot } from "@/lib/console/navigation";
import { isDbConfigured } from "@/lib/platform/db/client";
import { fmtCost, fmtCount } from "@/lib/platform/format";

export const metadata = { title: "Model calls" };

const PAGE_SIZE = 50;

const COLUMNS = [
  { id: "at", header: "Time", width: "11rem" },
  { id: "model", header: "Model" },
  { id: "input", header: "Input", align: "right", width: "6rem" },
  { id: "output", header: "Output", align: "right", width: "6rem", hiddenBelow: "sm" },
  { id: "cost", header: "Cost", align: "right", width: "6rem", hiddenBelow: "sm" },
  { id: "latency", header: "Latency", align: "right", width: "6rem", hiddenBelow: "md" },
  { id: "finish", header: "Finish", width: "7rem", hiddenBelow: "lg" },
] as const;

const count = (value: number | null) => (value === null ? "" : fmtCount(value));

/** Every model call the project's agents made, newest first. The layout guards the project. */
export default async function ModelCallsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ after?: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Model calls">
        Calls appear once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const [{ projectId }, { after }] = await Promise.all([params, searchParams]);
  const cursor = parseCallsCursor(typeof after === "string" ? after : undefined);
  const page = await listModelCalls(projectId, { limit: PAGE_SIZE, after: cursor });
  const base = `${projectRoot(projectId)}/calls`;
  return (
    <Page>
      <PageHeader title="Model calls" description="Newest first, from the agents' traces." />
      <PageBody wide>
        <TextTable
          caption="Model calls"
          columns={COLUMNS}
          rows={page.rows.map((call) => ({
            key: call.id,
            at: fmtUtc(call.at),
            model: [call.provider, call.model].filter(Boolean).join(" / "),
            input: count(call.inputTokens),
            output: count(call.outputTokens),
            cost: call.costUsd === null ? "" : fmtCost(call.costUsd),
            latency: call.latencyMs === null ? "" : `${fmtCount(call.latencyMs)} ms`,
            finish: call.finishReason ?? "",
          }))}
          empty={
            <EmptyState
              icon={Activity}
              title={cursor ? "No older calls" : "No model calls yet"}
              description="Calls show up here once the agents' traces reach /v1/traces."
            />
          }
        />
        {cursor || page.next ? (
          <nav aria-label="Pages" className="flex gap-2">
            {cursor ? (
              <Link href={base} className={buttonVariants({ variant: "secondary" })}>
                Newest
              </Link>
            ) : null}
            {page.next ? (
              <Link
                href={`${base}?after=${encodeURIComponent(page.next)}`}
                className={buttonVariants({ variant: "secondary" })}
              >
                Older
              </Link>
            ) : null}
          </nav>
        ) : null}
      </PageBody>
    </Page>
  );
}
