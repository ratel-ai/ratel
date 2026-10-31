import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import Link from "next/link";
import { FIX_GROUP_TITLES, groupAnchor, groupFixes } from "@/lib/views/fixes/groups";
import type { FixesModel, FixSource } from "@/lib/views/fixes/types";
import { compactCount } from "@/lib/views/home/overview-model";
import { EvidenceLegend, EvidenceMeter } from "./FixCells";
import { FixesList } from "./FixesList";
import { FIX_GROUP_ICONS } from "./kind-icons";

/**
 * Fixes (DESIGN.md, One question per page): what should I change? The
 * numbers lead, as marks: the open fixes by what you do, their evidence in
 * color, the issues they resolve and the model calls they save. Then one
 * table per thing you do, and the Panel.
 */

export const FIXES_DESCRIPTION = "Changes that would make your agent find and finish more.";

const SOURCE_WORDS: Record<FixSource, string> = {
  rewrite: "description rewrites",
  craft: "changes drafted from your tasks",
  issue: "issues from Agent health",
  intent: "skills for your intents",
};

export function FixesPage({
  projectId,
  model,
  now,
}: {
  projectId: string;
  model: FixesModel;
  now: string;
}) {
  const root = `/project/${encodeURIComponent(projectId)}`;
  const empty = model.open.length === 0 && model.applied.length === 0;
  return (
    <Page>
      <PageHeader
        title="Fixes"
        crumbs={[{ label: "Improvements", href: `${root}/improvement` }]}
        description={FIXES_DESCRIPTION}
      />
      <PageBody wide>
        {model.failed.length > 0 ? (
          <Callout tone="warning" title="Some fixes couldn't be loaded">
            {`The ${listOf(model.failed.map((source) => SOURCE_WORDS[source]))} didn't load, so they are missing below. Reload the page to try again.`}
          </Callout>
        ) : null}
        {empty ? (
          <div className="rounded-lg border border-line">
            <EmptyState
              emblem
              title="No fixes yet"
              description={
                model.rewritesOn
                  ? "Fixes appear when Agent health finds an issue with a clear change, when your tasks show steps to merge or retire, or when an analysis of your searches drafts a rewrite."
                  : "Fixes appear when Agent health finds an issue with a clear change, or when your tasks show steps to merge or retire."
              }
              action={
                <Link href={`${root}/health`} className={buttonVariants({ variant: "secondary" })}>
                  Open Agent health
                </Link>
              }
              secondary={
                model.rewritesOn ? (
                  <Link
                    href={`${root}/quality`}
                    className="rounded-md text-ui text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    Analyse searches on Quality
                  </Link>
                ) : null
              }
            />
          </div>
        ) : (
          <>
            <StatRow stats={fixStatProps(model, root)} />
            <FixesList model={model} now={now} />
          </>
        )}
      </PageBody>
    </Page>
  );
}

/**
 * The numbers, each with a mark: the open fixes with a jump to each table,
 * how many stand on strong evidence (every strength as pixels), the issues
 * they resolve, and the model calls they save where that can honestly be
 * summed.
 */
export function fixStatProps(model: FixesModel, root: string): StatProps[] {
  const { stats } = model;
  const out: StatProps[] = [
    { label: "Open fixes", value: compactCount(stats.open), trend: <GroupMarks model={model} /> },
    {
      label: "Strong evidence",
      value: compactCount(stats.evidence.strong),
      trend: <EvidenceMeter counts={stats.evidence} />,
      hint: <EvidenceLegend counts={stats.evidence} skip="strong" />,
    },
    {
      label: "Issues they resolve",
      value: compactCount(stats.issues),
      hint: "On Agent health",
      href: `${root}/health`,
    },
  ];
  if (stats.roundTripsSaved !== null) {
    out.push({
      label: "Model calls saved",
      value: compactCount(stats.roundTripsSaved),
      hint: "If you make every measured fix",
    });
  }
  return out;
}

/** The open fixes by what you do: each table's mark and count, a jump to the table. */
function GroupMarks({ model }: { model: FixesModel }) {
  const groups = groupFixes(model.open);
  if (groups.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {groups.map(({ group, fixes }) => {
        const Icon = FIX_GROUP_ICONS[group];
        return (
          <a
            key={group}
            href={`#${groupAnchor(group)}`}
            className="inline-flex items-center gap-1 rounded-md text-xs text-fg-muted tabular-nums outline-none transition-colors duration-120 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon aria-hidden strokeWidth={1.5} className="size-3.5" />
            {fixes.length}
            <span className="sr-only"> {FIX_GROUP_TITLES[group].toLowerCase()}</span>
          </a>
        );
      })}
    </span>
  );
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Without a database there is nothing to read; said in the page's own frame. */
export function FixesNoDatabase() {
  return (
    <Page>
      <PageHeader title="Fixes" description={FIXES_DESCRIPTION} />
      <PageBody>
        <Callout tone="warning" title="No database connected yet">
          Fixes become available once setup finishes.
        </Callout>
      </PageBody>
    </Page>
  );
}
