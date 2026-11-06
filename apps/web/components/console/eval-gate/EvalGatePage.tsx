import { StatusDot } from "@ratel/design-system/badge";
import { NounIcon } from "@ratel/design-system/entity";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { formatTimestamp } from "@/lib/synthesis/traces/format";
import type { EvalGatePageModel, EvalRunSummary } from "@/lib/views/eval-gate/page-model";
import { MIN_REPLAY_FIDELITY } from "@/lib/views/eval-gate/score";
import type { Tally } from "@/lib/views/eval-gate/types";
import {
  howItRan,
  passLine,
  percent,
  simulatedLabel,
  VERDICT_WORDS,
} from "@/lib/views/eval-gate/view";
import { EvalPoller, EvalRuns, PickRunsButton, RunSimulationButton } from "./EvalGateClient";
import { ReplayPathsSection } from "./ReplayPaths";

/** The callout's reason a fix can't be simulated, which the disabled "Run simulation" points to (RC-77). */
const BLOCKED_REASON_ID = "eval-blocked-reason";

/**
 * One fix's eval gate (DESIGN.md, One question per page): "Does this fix make
 * my agent better on my own runs?" Before and after lead, said to be a
 * simulation; then the runs, each editable; then the change and earlier
 * simulations.
 */
export function EvalGatePage({ model }: { model: EvalGatePageModel }) {
  const root = `/project/${encodeURIComponent(model.projectId)}`;
  const title = model.fix?.short ?? model.set?.title ?? "Eval gate";
  const pending = model.badge.state === "pending";
  const latest = model.latest;
  return (
    <Page>
      <PageHeader
        title={title}
        crumbs={[
          { label: "Improvements", href: `${root}/improvement` },
          { label: "Fixes", href: model.fix?.href ?? `${root}/improvement/fixes` },
        ]}
        description="The fix's eval gate: your past runs, replayed with the fix applied."
        actions={
          model.set ? (
            <RunSimulationButton
              projectId={model.projectId}
              fixId={model.fixId}
              pending={pending}
              first={!latest}
              blocked={model.blocked}
              reasonId={BLOCKED_REASON_ID}
            />
          ) : null
        }
      />
      <PageBody wide>
        {pending ? <EvalPoller projectId={model.projectId} fixId={model.fixId} /> : null}
        {!model.fix ? (
          <Callout tone="warning" title="This fix is no longer open">
            Its eval stays readable. Picking more runs needs the fix, so only its own runs can be
            edited.
          </Callout>
        ) : model.blocked || model.set?.unsupportedReason ? (
          <Callout title="This fix can't be simulated yet">
            <span id={BLOCKED_REASON_ID}>{model.blocked ?? model.set?.unsupportedReason}</span>
          </Callout>
        ) : (
          <Callout
            title={
              latest ? simulatedLabel(latest.nSimulated) : "A simulation, never your live agent"
            }
          >
            {howItRanOf(model)}
          </Callout>
        )}

        {!model.set ? (
          <div className="rounded-lg border border-line">
            <EmptyState
              emblem
              title="Not simulated yet"
              description="The eval picks runs from your traces: the issue's own runs first, then runs of the fix's tools and task. You can edit them before or after."
              action={
                <RunSimulationButton
                  projectId={model.projectId}
                  fixId={model.fixId}
                  pending={false}
                  first
                  blocked={model.blocked}
                  reasonId={BLOCKED_REASON_ID}
                />
              }
              secondary={<PickRunsButton projectId={model.projectId} fixId={model.fixId} />}
            />
          </div>
        ) : (
          <>
            {latest ? (
              <StatRow stats={statsOf(latest, model.badge.state === "done" && model.badge.stale)} />
            ) : null}
            {latest?.evidence ? <EvidenceNote latest={latest} /> : null}
            <EvalRuns model={model} />
            {model.cases.some((row) => row.replayPaths) ? (
              <ReplayPathsSection
                names={new Map(model.tools.map((tool) => [tool.id, tool.name]))}
                rows={model.cases.flatMap((row) =>
                  row.replayPaths
                    ? [
                        {
                          id: row.id,
                          turnId: row.turnId,
                          runHref: row.runHref,
                          label:
                            row.role === "evidence" ? "Issue's run · not counted" : row.originLabel,
                          paths: row.replayPaths,
                        },
                      ]
                    : [],
                )}
              />
            ) : null}
            <ChangeSection model={model} root={root} />
            {model.history.length > 1 ? <HistorySection history={model.history} /> : null}
          </>
        )}
      </PageBody>
    </Page>
  );
}

/** How the runs are simulated (RC-61), named from the fix's kind before the first run (RC-77). */
function howItRanOf(model: EvalGatePageModel): string {
  const latest = model.latest;
  return howItRan({
    planned: model.method,
    latest: latest
      ? {
          method: latest.method,
          verdict: latest.verdict,
          fidelity: latest.methods?.fidelity ?? null,
          judge: latest.judge,
        }
      : null,
    minFidelity: MIN_REPLAY_FIDELITY,
  });
}

/** The insight's own runs, scored apart (RC-61). */
function EvidenceNote({ latest }: { latest: EvalRunSummary }) {
  const evidence = latest.evidence!;
  return (
    <p className="text-xs text-fg-muted" data-eval-evidence>
      {evidence.nSimulated > 0 ? (
        <>
          The issue&apos;s own runs, scored apart:{" "}
          <span className="text-fg tabular-nums">{passLine(evidence.before, evidence.after)}</span>{" "}
          on {evidence.nSimulated} {evidence.nSimulated === 1 ? "run" : "runs"}. They were picked
          because they show the problem, so they don&apos;t count toward the verdict.
        </>
      ) : (
        <>The issue&apos;s own runs are kept apart and don&apos;t count toward the verdict.</>
      )}
    </p>
  );
}

function statsOf(latest: EvalRunSummary, stale: boolean): StatProps[] {
  // An unreliable replay's numbers aren't a reading of the fix: none are shown.
  const unreliable = latest.verdict === "unreliable";
  const before = unreliable ? null : latest.before;
  const after = unreliable ? null : latest.after;
  const verdict = latest.verdict ? VERDICT_WORDS[latest.verdict] : null;
  const passDelta =
    before?.passRate != null && after?.passRate != null
      ? Math.round((after.passRate - before.passRate) * 100)
      : null;
  const scoreDelta =
    before?.score != null && after?.score != null
      ? Math.round((after.score - before.score) * 100)
      : null;
  return [
    {
      label: "Runs passing",
      value: before && after ? passLine(before, after) : "–",
      ...(passDelta !== null
        ? {
            delta: {
              value: `${passDelta > 0 ? "+" : ""}${passDelta} pts`,
              direction: passDelta > 0 ? "up" : passDelta < 0 ? "down" : "flat",
              good: passDelta === 0 ? null : passDelta > 0,
              label: "after the fix",
            } as const,
          }
        : {}),
      hint:
        before && after
          ? `${before.passed} → ${after.passed} of ${after.total}${latest.evidence ? " runs held out from the issue" : ""}`
          : undefined,
    },
    ...groupStats(latest),
    {
      label: "Score",
      value: before && after ? `${percent(before.score)} → ${percent(after.score)}` : "–",
      ...(scoreDelta !== null
        ? {
            delta: {
              value: `${scoreDelta > 0 ? "+" : ""}${scoreDelta} pts`,
              direction: scoreDelta > 0 ? "up" : scoreDelta < 0 ? "down" : "flat",
              good: scoreDelta === 0 ? null : scoreDelta > 0,
            } as const,
          }
        : {}),
      hint: "Mean of each run's checks; the right tool earns more the higher it ranks",
    },
    {
      label: "Runs simulated",
      value: String(latest.nSimulated),
      hint: stale
        ? "The runs changed since; run it again"
        : latest.methods && latest.methods.none > 0
          ? `${latest.methods.none} can't be simulated; marked below`
          : latest.nCases > latest.nSimulated
            ? `of ${latest.nCases} in the eval; the rest are marked below`
            : "Every run in the eval",
    },
    {
      label: "Verdict",
      value: verdict ? (
        <StatusDot tone={verdict.tone} label={verdict.label} className="text-sm text-fg" />
      ) : (
        "–"
      ),
      hint: latest.finishedAt ? `Simulated ${formatTimestamp(latest.finishedAt)}` : undefined,
    },
  ];
}

/** The targeted check and how the runs ended, apart (RC-61); only groups some run was scored on. */
function groupStats(latest: EvalRunSummary): StatProps[] {
  const breakdown = latest.breakdown;
  if (!breakdown) return [];
  const stats: StatProps[] = [];
  const line = (pair: { before: Tally; after: Tally }) => passLine(pair.before, pair.after);
  if (breakdown.outcome.after.total > 0) {
    stats.push({
      label: "Targeted check",
      value: breakdown.target.after.total > 0 ? line(breakdown.target) : "–",
      hint: "What the fix aims at",
    });
    stats.push({
      label: "How runs ended",
      value: line(breakdown.outcome),
      hint: "Finishes cleanly, self-corrections, cost and time",
    });
  }
  if (breakdown.criteria.after.total > 0)
    stats.push({
      label: "Criteria",
      value: line(breakdown.criteria),
      hint: "Your words, judged by a model",
    });
  return stats;
}

/** What the simulation applies, in words, and where the fix came from. */
function ChangeSection({ model, root }: { model: EvalGatePageModel; root: string }) {
  const method = model.latest?.method ?? model.method;
  const lines =
    method === "replay" || method === "mixed"
      ? (model.set?.replayChange ?? [])
      : (model.set?.change ?? []);
  return (
    <Section
      title="What the simulation applies"
      description="The fix as a change to your past runs."
    >
      <div className="flex flex-col gap-3">
        {lines.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {lines.map((line) => (
              <li key={line} className="text-ui text-fg">
                {line}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ui text-fg-muted">Nothing the simulator can apply.</p>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          {model.source ? (
            <Link
              href={model.source.href ?? `${root}/health`}
              className="inline-flex items-center gap-1.5 rounded-md text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
              data-lineage-source={model.source.kind}
            >
              <NounIcon noun="issue" />
              From the issue: {model.source.label ?? "open it"}
              <ArrowUpRight aria-hidden className="size-3" />
            </Link>
          ) : null}
          {model.fix ? (
            <Link
              href={model.fix.href}
              className="inline-flex items-center gap-1.5 rounded-md text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
            >
              <NounIcon noun="fix" />
              Open the fix
              <ArrowUpRight aria-hidden className="size-3" />
            </Link>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

function HistorySection({ history }: { history: EvalRunSummary[] }) {
  return (
    <Section title="Earlier simulations">
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
        {history.map((run) => {
          const verdict = run.verdict ? VERDICT_WORDS[run.verdict] : null;
          return (
            <li
              key={run.id}
              className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-ui"
            >
              <time dateTime={run.createdAt} className="w-44 shrink-0 text-fg-muted tabular-nums">
                {formatTimestamp(run.createdAt)}
              </time>
              {run.status === "completed" && run.before && run.after ? (
                <span className="text-fg tabular-nums">{passLine(run.before, run.after)}</span>
              ) : null}
              {run.status === "completed" ? (
                <span className="text-xs text-fg-subtle tabular-nums">
                  {simulatedLabel(run.nSimulated)}
                </span>
              ) : run.status === "failed" ? (
                <StatusDot tone="danger" label="Failed" />
              ) : (
                <StatusDot tone="info" label="Simulating…" />
              )}
              {verdict && run.status === "completed" ? (
                <StatusDot tone={verdict.tone} label={verdict.label} className="ml-auto text-xs" />
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
