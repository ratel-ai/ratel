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
import { ComparePicker } from "./ComparePicker";

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
  same_experiment: "This is the same experiment",
  not_completed: "The experiment has not ended",
};

/**
 * An experiment against another one, the pinned baseline by default: the verdict and its rule, what
 * changed in the setup, then the changed cases with their outputs side by side.
 */
export function CompareView({ model, now }: { model: ComparePageModel; now: string }) {
  const { projectId, experimentId } = model;
  return (
    <Page>
      <PageHeader
        title="Compare experiments"
        actions={
          <ComparePicker
            projectId={projectId}
            experimentId={experimentId}
            choices={model.choices}
            chosenId={model.chosenId}
          />
        }
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
          <dt className="text-fg-subtle">{model.pin ? "Baseline" : "Compared with"}</dt>
          <dd>
            <ExperimentLink projectId={projectId} experiment={model.baseline} />
            {model.pin ? (
              <span className="text-fg-subtle" title={model.pin.at}>
                {" "}
                pinned by {model.pin.by} {formatRelativeTime(model.pin.at, now)}
              </span>
            ) : (
              <span className="text-fg-subtle"> · not the pinned baseline</span>
            )}
          </dd>
          <dt className="text-fg-subtle">Candidate</dt>
          <dd>
            <ExperimentLink projectId={projectId} experiment={model.candidate} />
          </dd>
        </dl>
      </section>
      <Section title="What changed in the setup">
        <SetupChanges model={model} />
      </Section>
      <Section
        title="Changed cases"
        description="The outputs of the two sides, trial by trial. Removed words are struck out, added words are marked."
      >
        {changed.length > 0 ? (
          <Cases projectId={projectId} rows={changed} showOutputs />
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

function Cases({
  projectId,
  rows,
  showOutputs = false,
}: {
  projectId: string;
  rows: ComparedCaseRow[];
  showOutputs?: boolean;
}) {
  return (
    <ul className="divide-y divide-line rounded-lg border border-line bg-raised">
      {rows.map((row) => (
        <li key={row.caseId}>
          <CompareCase projectId={projectId} row={row} showOutputs={showOutputs} />
        </li>
      ))}
    </ul>
  );
}

/** The version and the params that differ. The cases are matched by id, whatever their label. */
function SetupChanges({ model }: { model: Compared }) {
  const { baseline, candidate, params } = model;
  if (!model.versionChanged && params.length === 0) {
    return <p className="text-ui text-fg-muted">The same version and the same parameters.</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-raised">
      <table className="w-full text-ui">
        <thead>
          <tr className="text-left text-xs text-fg-muted">
            <th className="px-4 py-2 font-medium">Setting</th>
            <th className="px-4 py-2 font-medium">Baseline</th>
            <th className="px-4 py-2 font-medium">Candidate</th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs [&>tr>td]:border-t [&>tr>td]:border-line">
          {model.versionChanged ? (
            <tr>
              <td className="px-4 py-2 font-sans text-ui text-fg">Version</td>
              <td className="px-4 py-2 text-fg-muted">
                {baseline.sandboxVersionId.slice(0, 8)} · {baseline.commit.slice(0, 12)}
              </td>
              <td className="px-4 py-2 text-fg">
                {candidate.sandboxVersionId.slice(0, 8)} · {candidate.commit.slice(0, 12)}
              </td>
            </tr>
          ) : null}
          {params.map((param) => (
            <tr key={param.name}>
              <td className="px-4 py-2 text-fg">{param.name}</td>
              <td className="px-4 py-2 text-fg-muted">{param.baseline ?? "default"}</td>
              <td className="px-4 py-2 text-fg">{param.candidate ?? "default"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
        {experiment.name ?? `${experiment.sandboxName} · ${experiment.commit.slice(0, 12)}`}
      </Link>
      {experiment.dirty ? <span className="text-warning"> with uncommitted changes</span> : null}
    </>
  );
}
