import { Badge, type Tone } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import Link from "next/link";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { ScorerDifference, Verdict } from "@/lib/views/evals/domain/compare";
import type {
  ComparedCaseRow,
  ComparedExperiment,
  ComparePageModel,
} from "@/lib/views/evals/page-model";
import { caseHref, evalsHref, experimentHref } from "@/lib/views/evals/paths";
import { CompareCase } from "./CompareCase";

type Compared = Extract<ComparePageModel, { ok: true }>;

const VERDICT: Record<Verdict, { label: string; className: string }> = {
  regressed: { label: "Regressed", className: "border-danger text-danger" },
  improved: { label: "Improved", className: "border-success text-success" },
  unchanged: { label: "Unchanged", className: "border-line-active text-fg" },
  inconclusive: { label: "Inconclusive", className: "border-warning text-warning" },
};
const TALLY: Array<{ change: ComparedCaseRow["change"]; tone: Tone }> = [
  { change: "regressed", tone: "danger" },
  { change: "inconclusive", tone: "warning" },
  { change: "improved", tone: "success" },
  { change: "added", tone: "neutral" },
  { change: "removed", tone: "neutral" },
  { change: "unchanged", tone: "neutral" },
];
const DIFFERENCE: Record<ScorerDifference["difference"], string> = {
  changed: "The definition changed",
  gating: "Gating on one side, advisory on the other",
  added: "Not in the baseline",
  removed: "Only in the baseline",
};
const REFUSED: Record<string, string> = {
  scorers_differ: "Not compared: the scorers differ",
  no_baseline: "No baseline is pinned",
  same_experiment: "This experiment is the baseline",
  not_completed: "The experiment has not ended",
};

/** An experiment against the pinned baseline: the verdict, the changed cases, then the others. */
export function CompareView({ model, now }: { model: ComparePageModel; now: string }) {
  const { projectId, experimentId } = model;
  return (
    <Page>
      <PageHeader
        title="Compare with baseline"
        crumbs={[
          { label: "Evals", href: evalsHref(projectId) },
          { label: "Experiment", href: experimentHref(projectId, experimentId) },
        ]}
      />
      <PageBody>
        {model.ok ? <Result model={model} now={now} /> : <Refused model={model} />}
      </PageBody>
    </Page>
  );
}

function Result({ model, now }: { model: Compared; now: string }) {
  const { projectId, changed, others } = model;
  const verdict = VERDICT[model.verdict];
  const all = [...changed, ...others];
  return (
    <>
      <section aria-label="Verdict" className={cn("border-l-2 pl-5", verdict.className)}>
        <h2 className="text-3xl font-semibold tracking-tight">{verdict.label}</h2>
        <p className="mt-2 max-w-3xl text-sm text-fg-muted">{model.rule}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {TALLY.map(({ change, tone }) => {
            const count = all.filter((row) => row.change === change).length;
            return count > 0 ? (
              <Badge key={change} tone={tone}>
                {count} {change}
              </Badge>
            ) : null;
          })}
        </div>
        <dl className="mt-4 grid max-w-3xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui text-fg-muted">
          <dt className="text-fg-subtle">Baseline</dt>
          <dd>
            <ExperimentLink projectId={projectId} experiment={model.baseline} />
            <span className="text-fg-subtle" title={model.pinnedAt}>
              {" "}
              pinned by {model.pinnedBy} {formatRelativeTime(model.pinnedAt, now)}
            </span>
          </dd>
          <dt className="text-fg-subtle">Candidate</dt>
          <dd>
            <ExperimentLink projectId={projectId} experiment={model.candidate} />
          </dd>
        </dl>
      </section>
      <Section title="Changed cases">
        {changed.length > 0 ? (
          <Cases projectId={projectId} rows={changed} />
        ) : (
          <p className="text-ui text-fg-muted">No case changed.</p>
        )}
      </Section>
      {others.length > 0 ? (
        <Disclosure title="Other cases" hint={`${others.length} unchanged`}>
          <Cases projectId={projectId} rows={others} />
        </Disclosure>
      ) : null}
    </>
  );
}

function Cases({ projectId, rows }: { projectId: string; rows: ComparedCaseRow[] }) {
  return (
    <ul className="divide-y divide-line rounded-lg border border-line bg-raised">
      {rows.map((row) => (
        <li key={row.caseId}>
          <CompareCase projectId={projectId} row={row} />
        </li>
      ))}
    </ul>
  );
}

function Refused({ model }: { model: Extract<ComparePageModel, { ok: false }> }) {
  const { projectId, scorers } = model;
  return (
    <>
      <Callout tone="warning" title={REFUSED[model.reason] ?? "Not compared"}>
        {model.message}
        {model.baselineId ? (
          <Link
            href={experimentHref(projectId, model.baselineId)}
            className="ml-1 text-fg underline underline-offset-2 hover:text-fg-muted"
          >
            Open the baseline
          </Link>
        ) : null}
      </Callout>
      {scorers.length > 0 ? (
        <Section title="Scorers that differ">
          <ul className="divide-y divide-line rounded-lg border border-line bg-raised">
            {scorers.map((scorer, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: the list never changes its order
                key={index}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-ui"
              >
                <span className="font-medium text-fg">{scorer.name}</span>
                <Link
                  href={caseHref(projectId, scorer.caseId)}
                  className="text-fg-muted underline-offset-2 hover:underline"
                >
                  {scorer.caseName}
                </Link>
                <span className="ml-auto text-fg-subtle">{DIFFERENCE[scorer.difference]}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}

function ExperimentLink({
  projectId,
  experiment,
}: {
  projectId: string;
  experiment: ComparedExperiment;
}) {
  return (
    <>
      <Link
        href={experimentHref(projectId, experiment.id)}
        className="text-fg underline underline-offset-2 hover:text-fg-muted"
      >
        {experiment.sandboxName} · {experiment.commit.slice(0, 12)}
      </Link>
      {experiment.dirty ? <span className="text-warning"> with uncommitted changes</span> : null}
    </>
  );
}
