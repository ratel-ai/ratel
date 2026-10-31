import type { ReactNode } from "react";
import { entitled, loadQualityContext, type QualityContext } from "@/lib/views/quality/context";
import { loadDescriptions } from "@/lib/views/quality/load-descriptions";
import { loadExperiments } from "@/lib/views/quality/load-experiments";
import {
  loadMissRows,
  loadQualityEvidence,
  type QualityEvidence,
} from "@/lib/views/quality/load-misses";
import { loadRunState, type QualityRunState } from "@/lib/views/quality/load-suggestions";
import {
  type QualityTab,
  qualityTabHref,
  versusPhrase,
  widerWindow,
  windowLabel,
  windowOptions,
  windowPhrase,
  withParams,
} from "@/lib/views/quality/model";
import { DescriptionsView } from "./DescriptionsView";
import { ExperimentsView } from "./ExperimentsView";
import { RunMenu, WindowMenu } from "./HeaderControls";
import { MissesView } from "./MissesView";
import { HeadlineLine, QualityFrame } from "./QualityFrame";

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first ? first : null;
}

/**
 * One Quality tab, loaded and framed. Every tab shares the header (title, the
 * headline share, the window and the run menu), so each reads the header's
 * data alongside its own. The rewrites an analysis drafts live on
 * Descriptions, whose tab counts the ones waiting.
 */
export async function QualityPage({
  projectId,
  tab,
  searchParams,
}: {
  projectId: string;
  tab: QualityTab;
  searchParams: SearchParams;
}) {
  const context = await loadQualityContext(projectId, tab, searchParams);
  const { project, window, search } = context;
  const unlocked = context.sources.matchQuality && entitled(context);
  const state = await loadRunState(context);
  const evidence = unlocked
    ? await loadQualityEvidence({ projectId: project.id, window, run: state.run })
    : null;

  const path = qualityTabHref(project.id, tab);
  const experiment = tab === "experiments" ? single(searchParams.experiment) : null;
  const keep: Record<string, string | null> = { experiment };
  const body = await tabBody({
    tab,
    context,
    state,
    evidence,
    unlocked,
    path,
    keep,
    experiment,
    tool: single(searchParams.tool),
  });

  return (
    <QualityFrame
      projectId={project.id}
      tabs={context.tabs}
      search={search}
      meta={{
        misses: evidence?.missCount,
        descriptions: state.proposals.filter((proposal) => proposal.status === "pending").length,
      }}
      headline={
        unlocked && evidence ? (
          <HeadlineLine
            headline={evidence.headline}
            source={evidence.source}
            windowPhrase={windowPhrase(window)}
            versusPhrase={versusPhrase(window)}
            cut={evidence.cut ? evidence.readLimit : null}
          />
        ) : undefined
      }
      actions={
        <>
          <WindowMenu label={windowLabel(window)} options={windowOptions(path, window, keep)} />
          {state.menu ? <RunMenu projectId={project.id} model={state.menu} /> : null}
        </>
      }
    >
      {body}
    </QualityFrame>
  );
}

async function tabBody({
  tab,
  context,
  state,
  evidence,
  unlocked,
  path,
  keep,
  experiment,
  tool,
}: {
  tab: QualityTab;
  context: QualityContext;
  state: QualityRunState;
  evidence: QualityEvidence | null;
  unlocked: boolean;
  path: string;
  keep: Record<string, string | null>;
  experiment: string | null;
  /** Descriptions' `?tool=`: the tool a link asked for. */
  tool: string | null;
}): Promise<ReactNode> {
  const { project, window, search, now, billingHref } = context;
  const analyse = state.menu ? (
    <RunMenu projectId={project.id} model={state.menu} variant="primary" poll={false} />
  ) : null;

  if (tab === "misses") {
    // Names and trace links are read here only, each with its own fallback,
    // so a failure there costs a link, never the headline.
    const rows = evidence
      ? await loadMissRows({ projectId: project.id, evidence, window, proposals: state.proposals })
      : [];
    return (
      <MissesView
        projectId={project.id}
        evidence={evidence}
        rows={rows}
        locked={!unlocked}
        billingHref={billingHref}
        windowPhrase={windowPhrase(window)}
        wider={widerWindow(path, window)}
        analyse={analyse}
        now={now}
      />
    );
  }
  if (tab === "descriptions") {
    const data = unlocked ? await loadDescriptions({ context, state, evidence, tool }) : null;
    return (
      <DescriptionsView
        projectId={project.id}
        evidence={evidence}
        data={data}
        locked={!unlocked}
        billingHref={billingHref}
        analyse={analyse}
        windowPhrase={windowPhrase(window)}
        versusPhrase={versusPhrase(window)}
        now={now}
      />
    );
  }
  const data = await loadExperiments({
    projectId: project.id,
    window,
    windowSearch: search,
    requested: experiment,
  });
  const rowHrefs = Object.fromEntries(
    (data?.rows ?? []).map((row) => [
      row.name,
      row.kind === "ranking"
        ? withParams(path, search, { experiment: row.name })
        : (data?.detailHrefs[row.name] ?? path),
    ]),
  );
  return (
    <ExperimentsView
      projectId={project.id}
      data={data}
      rowHrefs={rowHrefs}
      windowPhrase={windowPhrase(window)}
      wider={widerWindow(path, window, keep)}
      now={now}
    />
  );
}
