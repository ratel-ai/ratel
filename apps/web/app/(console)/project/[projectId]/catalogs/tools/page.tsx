import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { Wrench } from "lucide-react";
import { TextTable } from "@/components/console/data/TextTable";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { fmtUtc } from "@/lib/console/format";
import { listObservedTools } from "@/lib/ingest/catalogs/queries";
import { isDbConfigured } from "@/lib/platform/db/client";
import { fmtCost, fmtCount } from "@/lib/platform/format";

export const metadata = { title: "Tools" };

const COLUMNS = [
  { id: "name", header: "Tool" },
  { id: "calls", header: "Calls", align: "right", width: "7rem" },
  { id: "tokens", header: "Tokens", align: "right", width: "8rem", hiddenBelow: "sm" },
  { id: "cost", header: "Cost", align: "right", width: "7rem", hiddenBelow: "sm" },
  { id: "lastSeen", header: "Last seen", width: "12rem", hiddenBelow: "md" },
] as const;

/** The tools a project's agents used, from the retained call metrics. The layout guards the project. */
export default async function ToolsPage({ params }: { params: Promise<{ projectId: string }> }) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Tools">Tools appear once setup finishes.</DatabaseUnavailable>
    );
  }
  const { projectId } = await params;
  const tools = await listObservedTools(projectId);
  return (
    <Page>
      <PageHeader title="Tools" description="Every tool the agents called, by calls." />
      <PageBody wide>
        <TextTable
          caption="Observed tools"
          columns={COLUMNS}
          rows={[...tools]
            .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
            .map((tool) => ({
              key: tool.name,
              name: tool.name,
              calls: fmtCount(tool.calls),
              tokens: fmtCount(tool.tokens),
              cost: fmtCost(tool.costUsd),
              lastSeen: fmtUtc(tool.lastSeenAt),
            }))}
          empty={
            <EmptyState
              icon={Wrench}
              title="No tool calls yet"
              description="Tools show up here once the agents' traces reach /v1/traces."
            />
          }
        />
      </PageBody>
    </Page>
  );
}
