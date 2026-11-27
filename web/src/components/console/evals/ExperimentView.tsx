"use client";

import { Badge } from "@ratel/design-system/badge";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Panel } from "@ratel/design-system/panel";
import { Section } from "@ratel/design-system/section";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { TrialResult } from "@/lib/views/evals/domain/score";
import type {
  ExperimentPageModel,
  GridRow,
  GridTrial,
  ScorerColumn,
  ScorerCount,
} from "@/lib/views/evals/page-model";
import { caseHref, evalHref, evalsHref, trialHref } from "@/lib/views/evals/paths";
import { BaselineActions, type BaselineState } from "./BaselineActions";
import { CountBadges, StateBadge } from "./RunBadges";
import { TrialPanel } from "./TrialPanel";

const REFRESH_MS = 3_000;
/** The widths of the grid columns that do not grow: case, input, expected, duration, cost. */
const FIXED_REM = 9 + 10 + 10 + 4.5 + 5;
const SCORER_REM = 6;
/** The trial switch of a row: a color for each result, and none while open. */
const SWITCH_TONE: Record<TrialResult | "open", string> = {
  pass: "border-success/50 text-success",
  fail: "border-danger/50 text-danger",
  invalid: "border-warning/50 text-warning",
  open: "border-line text-fg-faint",
};

/** One experiment as a grid: a row for each case, its output, its expected output, its scores. */
export function ExperimentView({
  model,
  baseline,
  canEdit,
  now,
}: {
  model: ExperimentPageModel;
  baseline: BaselineState;
  canEdit: boolean;
  now: string;
}) {
  const router = useRouter();
  const running = model.state === "running";
  const [openId, setOpenId] = useState<string | null>(null);
  const [lastOpen, setLastOpen] = useState<GridRow | null>(null);
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const open = model.rows.find((row) => row.versionId === openId) ?? null;
  const shown = open ?? lastOpen;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, router]);

  function openRow(row: GridRow) {
    setOpenId(row.versionId);
    setLastOpen(row);
  }
  const step = (by: number) => {
    const index = model.rows.findIndex((row) => row.versionId === openId);
    const next = model.rows[index + by];
    if (next) openRow(next);
  };

  return (
    <Page>
      <PageHeader
        title={model.name ?? `${model.sandboxName} · ${model.commit.slice(0, 12)}`}
        crumbs={[
          { label: "Evals", href: evalsHref(model.projectId) },
          ...(model.eval
            ? [{ label: model.eval.name, href: evalHref(model.projectId, model.eval.id) }]
            : []),
        ]}
        actions={
          running ? null : (
            <BaselineActions
              projectId={model.projectId}
              experimentId={model.id}
              baseline={baseline}
              canEdit={canEdit}
            />
          )
        }
      />
      <PageBody>
        <ExperimentHeader model={model} baseline={baseline} now={now} />
        {model.variants.length > 1 ? <VariantGrid model={model} /> : null}
        <Section
          title="Cases"
          description={
            running
              ? "Rows fill as the trials end. Open a row for its trials, tool calls, scorer reasons and logs."
              : "Open a row for its trials, tool calls, scorer reasons and logs."
          }
        >
          <div className="overflow-x-auto rounded-lg border border-line bg-raised">
            <table
              className="w-full table-fixed border-separate border-spacing-0 text-ui"
              // The output column keeps at least 14rem: more scorers make the grid scroll.
              style={{ minWidth: `${FIXED_REM + model.scorers.length * SCORER_REM + 14}rem` }}
            >
              <caption className="sr-only">The cases of the experiment</caption>
              <colgroup>
                <col style={{ width: "9rem" }} />
                <col style={{ width: "10rem" }} />
                <col />
                <col style={{ width: "10rem" }} />
                {model.scorers.map((scorer) => (
                  <col key={scorer.name} style={{ width: `${SCORER_REM}rem` }} />
                ))}
                <col style={{ width: "4.5rem" }} />
                <col style={{ width: "5rem" }} />
              </colgroup>
              <thead>
                <tr className="text-left text-xs text-fg-muted">
                  <Th>Case</Th>
                  <Th>Input</Th>
                  <Th>Output</Th>
                  <Th>Expected output</Th>
                  {model.scorers.map((scorer) => (
                    <Th key={scorer.name}>
                      <span className="block truncate" title={scorer.name}>
                        {scorer.name}
                      </span>
                      <span className="font-normal text-fg-faint">
                        {scorer.gating ? "gating" : "advisory"}
                      </span>
                    </Th>
                  ))}
                  <Th align="right">Duration</Th>
                  <Th align="right">Cost</Th>
                </tr>
              </thead>
              <tbody>
                {model.rows.map((row) => (
                  <GridLine
                    key={row.versionId}
                    row={row}
                    scorers={model.scorers}
                    selected={row.versionId === openId}
                    trialIndex={chosen[row.versionId] ?? firstEnded(row)}
                    onTrial={(index) => setChosen({ ...chosen, [row.versionId]: index })}
                    onOpen={() => openRow(row)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Section>
        <Panel
          open={open !== null}
          onOpenChange={(next) => (next ? undefined : setOpenId(null))}
          title={shown?.name ?? ""}
          subtitle={shown ? `Case v${shown.number} · ${shown.trials.length} trials` : undefined}
          actions={
            shown ? (
              <Link
                href={caseHref(model.projectId, shown.caseId)}
                className="text-ui text-accent-fg underline-offset-2 hover:underline"
              >
                Open the case
              </Link>
            ) : null
          }
          onPrevious={() => step(-1)}
          onNext={() => step(1)}
          size="wide"
        >
          {shown ? <RowDetails projectId={model.projectId} row={shown} /> : null}
        </Panel>
      </PageBody>
    </Page>
  );
}

function ExperimentHeader({
  model,
  baseline,
  now,
}: {
  model: ExperimentPageModel;
  baseline: BaselineState;
  now: string;
}) {
  const params = Object.entries(model.params);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-raised p-4">
      <div className="flex flex-wrap items-center gap-3">
        <StateBadge state={model.state} />
        {baseline === "this" ? <Badge tone="accent">Baseline</Badge> : null}
        <CountBadges counts={model.counts} />
        {model.dirty ? <Badge tone="warning">Uncommitted changes</Badge> : null}
        <span className="ml-auto text-xs text-fg-subtle" title={model.createdAt}>
          {formatRelativeTime(model.createdAt, now)}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-ui md:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        <dt className="text-fg-subtle">Sandbox</dt>
        <dd className="text-fg">{model.sandboxName}</dd>
        <dt className="text-fg-subtle">Version</dt>
        <dd className="truncate font-mono text-xs text-fg" title={model.sandboxVersionId}>
          {model.sandboxVersionId}
        </dd>
        <dt className="text-fg-subtle">Commit</dt>
        <dd className="truncate font-mono text-xs text-fg" title={model.commit}>
          {model.commit.slice(0, 12) || "none"}
        </dd>
        <dt className="text-fg-subtle">Cases</dt>
        <dd className="text-fg">
          {model.labelFilter ? (
            <>
              Label <Badge tone="neutral">{model.labelFilter}</Badge>
            </>
          ) : (
            "All"
          )}{" "}
          <span className="text-fg-subtle">
            · {model.rows.length} × {model.trialsPerCase} trials
          </span>
        </dd>
        <dt className="text-fg-subtle">Parameters</dt>
        <dd className="flex flex-wrap gap-1.5">
          {model.variants.length > 1 ? (
            <span className="text-fg">Matrix ({model.variants.length} variants)</span>
          ) : null}
          {params.length === 0 && model.variants.length <= 1 ? (
            <span className="text-fg-subtle">Defaults</span>
          ) : null}
          {params.map(([name, value]) => (
            <code
              key={name}
              className="rounded border border-line bg-rail px-1.5 py-0.5 font-mono text-xs text-fg"
            >
              {name}={typeof value === "string" ? value : JSON.stringify(value)}
            </code>
          ))}
        </dd>
        <dt className="text-fg-subtle">Total cost</dt>
        <dd className="font-mono text-xs text-fg">
          {model.costUsd === null ? "Not reported" : formatUsd(model.costUsd)}
        </dd>
      </dl>
    </div>
  );
}

function GridLine({
  row,
  scorers,
  selected,
  trialIndex,
  onTrial,
  onOpen,
}: {
  row: GridRow;
  scorers: ScorerColumn[];
  selected: boolean;
  trialIndex: number;
  onTrial: (index: number) => void;
  onOpen: () => void;
}) {
  const trial = row.trials[trialIndex];
  function onKeyDown(event: KeyboardEvent<HTMLTableRowElement>) {
    if (event.target !== event.currentTarget || event.key !== "Enter") return;
    event.preventDefault();
    onOpen();
  }
  return (
    <tr
      tabIndex={0}
      aria-selected={selected}
      onClick={(event) => {
        if ((event.target as Element).closest("button, a")) return;
        onOpen();
      }}
      onKeyDown={onKeyDown}
      className="cursor-pointer align-top outline-none hover:bg-hover focus-visible:bg-hover aria-selected:bg-selected [&>td]:border-t [&>td]:border-line"
    >
      <Td>
        <span className="block truncate font-medium text-fg" title={row.name}>
          {row.name}
        </span>
        <span className="text-xs text-fg-subtle">v{row.number}</span>
      </Td>
      <Td>
        <code className="line-clamp-3 font-mono text-xs break-words text-fg" title={row.input}>
          {row.input}
        </code>
        {row.turns > 0 ? <span className="text-xs text-fg-subtle">+{row.turns} turns</span> : null}
      </Td>
      <Td>
        <TrialSwitch row={row} index={trialIndex} onChange={onTrial} />
        {trial ? <TrialOutput trial={trial} /> : null}
      </Td>
      <Td>
        {row.expectedOutput === null ? (
          <span className="text-xs text-fg-faint">None</span>
        ) : (
          <span className="line-clamp-3 text-fg-muted" title={row.expectedOutput}>
            {row.expectedOutput}
          </span>
        )}
      </Td>
      {scorers.map((scorer) => (
        <Td key={scorer.name}>
          <ScoreCell count={row.scorerCounts[scorer.name]} />
        </Td>
      ))}
      <Td align="right">
        <span className="font-mono text-xs text-fg-muted">
          {row.durationMs === null ? "—" : `${(row.durationMs / 1000).toFixed(1)} s`}
        </span>
      </Td>
      <Td align="right">
        <span className="font-mono text-xs text-fg-muted">
          {row.costUsd === null ? "—" : formatUsd(row.costUsd)}
        </span>
      </Td>
    </tr>
  );
}

/**
 * A matrix run: a column for each variant, side by side, with its param values in the header. A
 * cell shows the passes of the variant's trials of the case, the output of its first ended trial,
 * and a link to that trial next to the baseline trial.
 */
function VariantGrid({ model }: { model: ExperimentPageModel }) {
  return (
    <Section
      title="Variants side by side"
      description="Each column is a combination of the matrix. Open a trial to see it next to the baseline trial."
    >
      <div className="overflow-x-auto rounded-lg border border-line bg-raised">
        <table
          className="w-full table-fixed border-separate border-spacing-0 text-ui"
          style={{ minWidth: `${19 + model.variants.length * 16}rem` }}
        >
          <caption className="sr-only">The variants of the run, side by side</caption>
          <colgroup>
            <col style={{ width: "9rem" }} />
            <col style={{ width: "10rem" }} />
            {model.variants.map(({ index }) => (
              <col key={index} />
            ))}
          </colgroup>
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <Th>Case</Th>
              <Th>Input</Th>
              {model.variants.map(({ index, label }) => (
                <Th key={index}>
                  <span className="block font-mono text-fg">{label || `Variant ${index + 1}`}</span>
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <tr key={row.versionId} className="align-top [&>td]:border-t [&>td]:border-line">
                <Td>
                  <span className="block truncate font-medium text-fg" title={row.name}>
                    {row.name}
                  </span>
                </Td>
                <Td>
                  <code
                    className="line-clamp-3 font-mono text-xs break-words text-fg"
                    title={row.input}
                  >
                    {row.input}
                  </code>
                </Td>
                {model.variants.map(({ index }) => {
                  const trials = row.trials.filter(({ variant }) => variant === index);
                  const ended = trials.filter(({ result }) => result !== null);
                  const passed = ended.filter(({ result }) => result === "pass").length;
                  const shown = ended[0] ?? trials[0];
                  return (
                    <Td key={index}>
                      <span className="mb-1 flex items-center gap-2 text-xs">
                        <span className="font-mono text-fg-muted">
                          {passed}/{trials.length} pass
                        </span>
                        {shown ? (
                          <Link
                            href={trialHref(model.projectId, model.id, shown.id)}
                            className="text-fg-subtle hover:text-fg hover:underline"
                          >
                            Trial
                          </Link>
                        ) : null}
                      </span>
                      {shown ? <TrialOutput trial={shown} /> : null}
                    </Td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** One button for each trial, colored by its result, to choose the output that the row shows. */
function TrialSwitch({
  row,
  index,
  onChange,
}: {
  row: GridRow;
  index: number;
  onChange: (index: number) => void;
}) {
  if (row.trials.length < 2) return null;
  return (
    <div className="mb-1.5 flex gap-1" role="toolbar" aria-label={`Trials of ${row.name}`}>
      {row.trials.map((trial, at) => (
        <button
          key={trial.id}
          type="button"
          aria-pressed={at === index}
          title={`Trial ${trial.index + 1}: ${trial.result ?? "open"}`}
          onClick={() => onChange(at)}
          className={`h-5 min-w-5 rounded border px-1 font-mono text-[11px] leading-none aria-pressed:bg-selected aria-pressed:ring-1 aria-pressed:ring-focus ${SWITCH_TONE[trial.result ?? "open"]}`}
        >
          {trial.index + 1}
        </button>
      ))}
    </div>
  );
}

/** The output of a trial. An invalid trial shows why, and never a pass or a fail. */
function TrialOutput({ trial }: { trial: GridTrial }) {
  if (trial.result === null) {
    return <span className="text-xs text-fg-subtle">Running…</span>;
  }
  if (trial.result === "invalid") {
    return (
      <span className="flex flex-col gap-1">
        <Badge tone="warning">Invalid</Badge>
        <span className="line-clamp-3 text-xs text-fg-muted">{trial.reason}</span>
      </span>
    );
  }
  return (
    <span className="line-clamp-4 text-fg" title={trial.output ?? undefined}>
      {trial.output ?? <span className="text-xs text-fg-faint">No output</span>}
      {trial.result === "fail" && trial.reason && trial.output === null ? (
        <span className="block text-xs text-danger">{trial.reason}</span>
      ) : null}
    </span>
  );
}

/** The raw counts of a scorer: never a rate. */
function ScoreCell({ count }: { count: ScorerCount | undefined }) {
  if (!count) return <span className="text-xs text-fg-faint">—</span>;
  return (
    <span className="flex flex-col gap-0.5 font-mono text-xs">
      {count.pass > 0 ? <span className="text-success">{count.pass} pass</span> : null}
      {count.fail > 0 ? <span className="text-danger">{count.fail} fail</span> : null}
      {count.notScored > 0 ? (
        <span className="text-warning">{count.notScored} not scored</span>
      ) : null}
    </span>
  );
}

/** The side panel of a row: the case, then each trial with its evidence and logs. */
function RowDetails({ projectId, row }: { projectId: string; row: GridRow }) {
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-ui">
        <dt className="text-fg-subtle">Input</dt>
        <dd>
          <code className="font-mono text-xs break-words text-fg">{row.input}</code>
          {row.turns > 0 ? (
            <span className="text-xs text-fg-subtle"> · +{row.turns} turns</span>
          ) : null}
        </dd>
        <dt className="text-fg-subtle">Expected</dt>
        <dd className="text-fg-muted">{row.expectedOutput ?? "None"}</dd>
        <dt className="text-fg-subtle">Trials</dt>
        <dd>
          <CountBadges counts={row.counts} />
        </dd>
      </dl>
      <ol className="flex flex-col gap-3">
        {row.trials.map((trial) => (
          <li
            key={trial.id}
            className={`rounded-lg border border-line p-3 ${trial.result ? "" : "border-dashed"}`}
          >
            <TrialPanel projectId={projectId} trial={trial} loadEvidence showLogs />
          </li>
        ))}
      </ol>
    </div>
  );
}

function Th({ children, align }: { children: ReactNode; align?: "right" }) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 align-bottom font-medium ${align === "right" ? "text-right" : ""}`}
    >
      {children}
    </th>
  );
}

function Td({ children, align }: { children: ReactNode; align?: "right" }) {
  return (
    <td className={`min-w-0 px-3 py-2.5 ${align === "right" ? "text-right" : ""}`}>{children}</td>
  );
}

/** The first trial that ended, so a row shows an output as soon as it has one. */
function firstEnded(row: GridRow): number {
  const at = row.trials.findIndex((trial) => trial.result === "pass" || trial.result === "fail");
  return at === -1 ? 0 : at;
}

function formatUsd(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}
