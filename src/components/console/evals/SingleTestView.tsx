"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { Check, CircleX, X } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode, useState } from "react";
import type { ToolAnswerSource } from "@/lib/views/eval-gate/types";
import { type RunSettingsUsed, runSettingsSummary } from "@/lib/views/evals/domain/run-settings";
import type { Eval, EvalResult, EvalRun } from "@/lib/views/evals/domain/types";
import { editEvalHref } from "@/lib/views/evals/paths";
import {
  attemptsLine,
  differIndex,
  generatedLine,
  measuredText,
  type RuleWithSource,
  SOURCE_LABELS,
  sourceCounts,
  type TestStep,
  type TurnRow,
  testSteps,
  totalsLine,
  turnRows,
} from "@/lib/views/evals/test-view";
import type { TaskTag } from "@/lib/views/evals/view";
import type { EvalRunReadings } from "@/lib/views/scorers/page";
import { EvalRunReplay } from "./EvalRunReplay";
import { GeneratedMark, RUN_KIND_LABELS, SourceNote } from "./marks";
import { PendingRun } from "./PendingRun";

const SOURCE_TONE: Record<ToolAnswerSource, Tone> = {
  recorded: "neutral",
  composed: "info",
  earlier: "neutral",
  "stand-in": "warning",
  mock: "info",
};
const TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

/**
 * The single test view (F1, F3): what is tested, what should happen with each
 * scorer's result, and one replay with the source of every tool answer (G1–G3,
 * G5). A click on a step shows the source's rule, the reason, and the call's
 * args and result when the text was kept.
 */
export function SingleTestView({
  item,
  tasks,
  rules,
  run,
  result,
  replayHref,
  previous = null,
  pending = null,
  readings = null,
}: {
  item: Eval;
  tasks: readonly TaskTag[];
  rules: readonly RuleWithSource[];
  run: EvalRun | null;
  result: EvalResult | null;
  replayHref: string | null;
  /** RC-642: the eval's completed result before this run: the replay marks where they differ. */
  previous?: EvalResult | null;
  /** RC-642: the run asked for, still queued or running. */
  pending?: EvalRun | null;
  /** RC-628, RC-657: the task and suite scorers' readings of this run, in the same table as the built-in scorers. */
  readings?: EvalRunReadings | null;
}) {
  return (
    <TestLayout
      item={item}
      tasks={tasks}
      replayHref={replayHref}
      should={
        <ShouldHappen
          rules={rules}
          readings={readings}
          columns={[{ label: run ? TIME.format(run.createdAt) : "Result", result }]}
        />
      }
      happened={
        pending ? (
          <PendingRun run={pending} />
        ) : run && result ? (
          <Replay
            item={item}
            result={result}
            title={RUN_KIND_LABELS[run.kind]}
            subtitle={`Replayed · ${TIME.format(run.createdAt)}`}
            stepper={
              result.transcript ? (
                <EvalRunReplay
                  projectId={item.projectId}
                  evalId={item.id}
                  runId={run.id}
                  item={item}
                  result={result}
                  previous={previous}
                />
              ) : null
            }
          />
        ) : (
          <Callout title="Not run yet">
            Run all on the Evals page to see this eval against the agent as recorded.
          </Callout>
        )
      }
    />
  );
}

/**
 * RC-294, F2: one eval of a fix's simulation. "What should happen" has a
 * column for today and one with the fix, and "What happened" shows the two
 * replays side by side with a "Runs differ from here" line. An eval the fix
 * does not touch has one replay, "Same as today" (Q10).
 */
export function CompareTestView({
  item,
  tasks,
  rules,
  before,
  after,
  replayHref,
}: {
  item: Eval;
  tasks: readonly TaskTag[];
  rules: readonly RuleWithSource[];
  before: EvalResult | null;
  after: EvalResult | null;
  replayHref: string | null;
}) {
  if (!after) {
    return (
      <TestLayout
        item={item}
        tasks={tasks}
        replayHref={replayHref}
        should={<ShouldHappen rules={rules} columns={[{ label: "Today", result: before }]} />}
        happened={
          before ? (
            <Replay
              item={item}
              result={before}
              title="Same as today"
              subtitle="The fix changes nothing this eval's model sees, so it ran once."
            />
          ) : (
            <Callout title="Not run">This eval has no result in this simulation.</Callout>
          )
        }
      />
    );
  }
  const differAt = before ? differIndex(testSteps(before).steps, testSteps(after).steps) : null;
  return (
    <TestLayout
      item={item}
      tasks={tasks}
      replayHref={replayHref}
      should={
        <ShouldHappen
          rules={rules}
          columns={[
            { label: "Today", result: before },
            { label: "With the fix", result: after },
          ]}
        />
      }
      happened={
        <div className="grid gap-4 lg:grid-cols-2">
          {before ? (
            <Replay
              item={item}
              result={before}
              title="Without the fix"
              subtitle="Replayed from the recording"
              differAt={differAt}
            />
          ) : (
            <Callout title="Without the fix">No replay of today.</Callout>
          )}
          <Replay
            item={item}
            result={after}
            title="With the fix"
            subtitle="Simulated"
            differAt={differAt}
          />
        </div>
      }
    />
  );
}

/** RC-657: the result first (one scorer table), then the scenario in one block, then the replay (UX audit RC-656, 2.2). */
function TestLayout({
  item,
  tasks,
  replayHref,
  should,
  happened,
}: {
  item: Eval;
  tasks: readonly TaskTag[];
  replayHref: string | null;
  should: ReactNode;
  happened: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-8">
      <Section
        title="Scorers"
        description="Every scorer that read this eval: built-in, from its tasks and from the suite."
      >
        {should}
      </Section>
      <Section title="Scenario">
        <div className="flex flex-col gap-2" data-group="scenario">
          {item.earlierMessages.length > 0 ? (
            <p className="text-ui text-fg-muted">
              After {item.earlierMessages.length} earlier{" "}
              {item.earlierMessages.length === 1 ? "message" : "messages"}, given as history and not
              tested.
            </p>
          ) : null}
          <p className="max-w-xl rounded-lg bg-raised px-3 py-2 text-sm text-fg">
            {item.message || "The recorded ask was not captured."}
          </p>
          {item.turns.length > 0 ? (
            <p className="text-ui text-fg-muted">
              Then {item.turns.length} more {item.turns.length === 1 ? "turn" : "turns"} of the
              conversation.
            </p>
          ) : null}
          <span className="flex flex-wrap gap-1">
            {tasks.map((task) => (
              <Badge key={task.id}>{task.label}</Badge>
            ))}
          </span>
        </div>
      </Section>
      <Section
        title="Replay"
        actions={
          replayHref ? (
            <Link href={replayHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Open the full replay
            </Link>
          ) : null
        }
      >
        {happened}
      </Section>
    </div>
  );
}

function ShouldHappen({
  rules,
  columns,
  readings = null,
}: {
  rules: readonly RuleWithSource[];
  columns: readonly { label: string; result: EvalResult | null }[];
  readings?: EvalRunReadings | null;
}) {
  const own = readings ? readings.readings.length + readings.off.length : 0;
  if (rules.length === 0 && own === 0)
    return (
      <p className="text-ui text-fg-muted">
        No scorers: its tasks have none and this eval adds none.
      </p>
    );
  return (
    <table className="w-full text-ui">
      <thead>
        <tr className="text-left text-xs text-fg-subtle">
          <th className="pb-2 font-normal">Scorer</th>
          {columns.map((column) => (
            <th key={column.label} className="w-40 pb-2 font-normal">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-line border-t border-line">
        {rules.map(({ scorer, sentence }) => (
          <tr key={scorer.kind} data-scorer={scorer.kind}>
            <td className="py-2 pr-3 text-fg">
              {sentence} <SourceNote>Built-in</SourceNote>
            </td>
            {columns.map((column) => {
              const verdict = column.result?.verdicts.find((entry) => entry.kind === scorer.kind);
              return (
                <td key={column.label} className="py-2">
                  {verdict ? (
                    <span className="inline-flex items-center gap-2">
                      {verdict.status === "pass" ? (
                        <Check className="size-3.5 text-success" aria-label="Pass" />
                      ) : verdict.status === "fail" ? (
                        <X className="size-3.5 text-danger" aria-label="Fail" />
                      ) : (
                        <span className="text-fg-faint" aria-label="Does not apply">
                          ·
                        </span>
                      )}
                      <span className="text-fg-muted tabular-nums">{measuredText(verdict)}</span>
                    </span>
                  ) : (
                    <span className="text-fg-faint">·</span>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
        {readings?.readings.map((reading) => (
          <tr key={reading.scorerId} data-scorer-reading={reading.scorerId}>
            <td className="py-2 pr-3 text-fg">{reading.name}</td>
            <td className="py-2" colSpan={columns.length}>
              <span className="inline-flex items-center gap-2">
                {reading.status === "pass" ? (
                  <Check className="size-3.5 text-success" aria-label="Pass" />
                ) : reading.status === "fail" ? (
                  <X className="size-3.5 text-danger" aria-label="Fail" />
                ) : (
                  <span className="text-fg-faint" aria-label="Not measured">
                    ·
                  </span>
                )}
                <span className="max-w-80 truncate font-mono text-xs text-fg-muted">
                  {reading.status === "pass" || reading.status === "fail"
                    ? reading.detail
                    : "not measured"}
                </span>
              </span>
            </td>
          </tr>
        ))}
        {readings?.off.map((name) => (
          <tr key={`off:${name}`}>
            <td className="py-2 pr-3 text-fg-muted">{name}</td>
            <td className="py-2 text-fg-muted" colSpan={columns.length}>
              Off for this eval
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** `stepper` (RC-648): the session replay of the run, in place of the static step list. */
function Replay({
  item,
  result,
  title,
  subtitle,
  differAt = null,
  stepper = null,
}: {
  item: Eval;
  result: EvalResult;
  title: string;
  subtitle: string;
  differAt?: number | null;
  stepper?: ReactNode;
}) {
  const { steps, textKept } = testSteps(result);
  const counts = sourceCounts(result.toolAnswers);
  const attempts = attemptsLine(result);
  const generated = generatedLine(result);
  const turns = turnRows(result);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-line p-4",
        !stepper && "max-w-3xl",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold text-fg">{title}</span>
        <span className="text-ui text-fg-muted">{subtitle}</span>
        <span className="flex-1" />
        {result.passed === true ? (
          <span className="inline-flex items-center gap-1 text-ui text-success">
            <Check className="size-3.5" aria-hidden />
            Passes
          </span>
        ) : result.passed === false ? (
          <span className="inline-flex items-center gap-1 text-ui text-danger">
            <X className="size-3.5" aria-hidden />
            Fails
          </span>
        ) : (
          <span className="text-ui text-warning">Could not run</span>
        )}
      </div>
      {result.runSettings ? <RunSettingsLine settings={result.runSettings} /> : null}
      {attempts ? (
        <p className="text-ui text-fg tabular-nums" data-attempts>
          {attempts}
          <span className="text-fg-muted">
            {" "}
            · a simulated person writes some turns, so each run differs. The steps below are from{" "}
            {result.passed === false ? "the first run that failed" : "the last run"}.
          </span>
        </p>
      ) : null}
      {turns ? <TurnList turns={turns} /> : null}
      {result.error ? (
        <Callout tone="warning" title="The replay stopped">
          {result.error}
        </Callout>
      ) : null}
      {generated ? (
        <p className="flex flex-wrap items-center gap-2 text-ui text-fg-muted">
          <GeneratedMark />
          <span data-generated>{generated}</span>
        </p>
      ) : null}
      {result.transcript ? (
        <Disclosure
          title="Tools offered"
          hint={`${result.transcript.toolsOffered.length} ${result.transcript.toolsOffered.length === 1 ? "tool" : "tools"}`}
        >
          <p className="font-mono text-ui text-fg">{result.transcript.toolsOffered.join(", ")}</p>
        </Disclosure>
      ) : null}
      {counts.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1.5 text-ui text-fg-muted" data-source-counts>
          Tool answers:
          {counts.map((entry) => (
            <Badge key={entry.source} tone={SOURCE_TONE[entry.source]}>
              {entry.label}
            </Badge>
          ))}
        </p>
      ) : null}
      {!textKept ? (
        <Callout title="No text for this run">
          An eval run keeps its text for 30 days, so the ask, arguments, results and reply of this
          run are not shown. Run the eval again to step through it.
        </Callout>
      ) : null}
      {stepper}
      {!stepper && textKept && item.message ? (
        <p className="ml-auto max-w-xl rounded-lg bg-raised px-3 py-2 text-sm text-fg">
          {item.message}
        </p>
      ) : null}
      {stepper ? null : (
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <Fragment key={index}>
              {differAt === index ? <DifferLine /> : null}
              <StepRow
                step={step}
                open={open === index}
                onToggle={() => setOpen(open === index ? null : index)}
                mockHref={editEvalHref(item.projectId, item.id, { run: result.runId, mock: index })}
              />
            </Fragment>
          ))}
          {differAt !== null && differAt >= steps.length ? <DifferLine /> : null}
        </ol>
      )}
      <p className="text-ui text-fg-muted tabular-nums">{totalsLine(result)}</p>
    </div>
  );
}

function DifferLine() {
  return (
    <li
      data-differ
      className="flex items-center gap-2 text-xs text-info"
      aria-label="Runs differ from here"
    >
      <span>Runs differ from here</span>
      <span className="h-px flex-1 border-t border-dashed border-info/60" aria-hidden />
    </li>
  );
}

/** RC-309: each turn's kind, result and verdicts, in order. */
function TurnList({ turns }: { turns: readonly TurnRow[] }) {
  return (
    <ol className="flex flex-col divide-y divide-line rounded-md border border-line" data-turns>
      {turns.map((turn) => (
        <li
          key={turn.label}
          className="flex flex-col gap-1 px-3 py-2 text-ui"
          data-turn-status={turn.status}
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{turn.label}</span>
            <Badge>{turn.kind}</Badge>
            <span className="flex-1" />
            {turn.status === "pass" ? (
              <span className="inline-flex items-center gap-1 text-success">
                <Check className="size-3.5" aria-hidden />
                Passes
              </span>
            ) : turn.status === "fail" ? (
              <span className="inline-flex items-center gap-1 text-danger">
                <X className="size-3.5" aria-hidden />
                Fails
              </span>
            ) : (
              <span className="text-fg-muted">Not scored</span>
            )}
          </span>
          {turn.message ? <span className="text-fg-muted">{turn.message}</span> : null}
          {turn.verdicts.length > 0 ? (
            <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
              {turn.verdicts.map((verdict) => (
                <span key={verdict.kind} className="inline-flex items-center gap-1 tabular-nums">
                  {verdict.status === "pass" ? (
                    <Check className="size-3 text-success" aria-label="Pass" />
                  ) : verdict.status === "fail" ? (
                    <X className="size-3 text-danger" aria-label="Fail" />
                  ) : (
                    <span aria-label="Does not apply">·</span>
                  )}
                  {verdict.label}
                  {verdict.measured ? ` ${verdict.measured}` : ""}
                </span>
              ))}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function StepRow({
  step,
  open,
  onToggle,
  mockHref,
}: {
  step: TestStep;
  open: boolean;
  onToggle: () => void;
  mockHref: string;
}) {
  if (step.kind === "reply")
    return <li className="max-w-xl rounded-lg bg-raised px-3 py-2 text-sm text-fg">{step.text}</li>;
  const standIn = step.source === "stand-in";
  return (
    <li
      data-source={step.source}
      className={cn(
        "rounded-md border",
        step.isError ? "border-danger/50" : standIn ? "border-warning/50" : "border-line",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {step.isError ? (
          <CircleX className="size-3.5 text-danger" aria-label="Failed" />
        ) : (
          <Check className="size-3.5 text-success" aria-label="Answered" />
        )}
        <span className="flex-1 font-mono text-ui text-fg">{step.tool}</span>
        <Badge tone={SOURCE_TONE[step.source]}>{SOURCE_LABELS[step.source]}</Badge>
        {step.ms !== null ? (
          <span className="w-16 text-right text-xs text-fg-muted tabular-nums">
            {step.ms < 1000 ? `${step.ms} ms` : `${(step.ms / 1000).toFixed(1)} s`}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className={cn(
            "flex flex-col gap-2 border-t px-3 py-2 text-ui",
            standIn ? "border-warning/40" : "border-line",
          )}
        >
          <p className={standIn ? "text-warning" : "text-fg-muted"}>{step.rule}</p>
          <p className="text-fg">{step.reason}</p>
          {step.args !== null ? (
            <>
              <p className="text-xs text-fg-subtle">Called with</p>
              <pre className="overflow-x-auto rounded-md bg-raised p-2 font-mono text-xs text-fg">
                {step.args}
              </pre>
            </>
          ) : null}
          {step.result !== null ? (
            <>
              <p className="text-xs text-fg-subtle">Returned</p>
              <pre className="overflow-x-auto rounded-md bg-raised p-2 font-mono text-xs text-fg">
                {step.result}
              </pre>
            </>
          ) : null}
          <Link
            href={mockHref}
            className="self-start text-ui text-fg-muted underline underline-offset-2 hover:text-fg"
            data-set-mock
          >
            Set a fixed answer for {step.tool}
          </Link>
        </div>
      ) : null}
    </li>
  );
}

/** RC-653: the run settings this result used. RC-657: each with its source in words, the default too (UX audit P4). */
function RunSettingsLine({ settings }: { settings: RunSettingsUsed }) {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-ui" data-run-settings-used>
      {runSettingsSummary(settings).map((entry) => (
        <div
          key={entry.key}
          className="flex items-baseline gap-1.5"
          data-setting={entry.key}
          data-source={entry.source}
        >
          <dt className="text-fg-muted">{entry.label}</dt>
          <dd className="font-mono text-fg">{entry.value}</dd>
          <SourceNote>
            {entry.source === "eval"
              ? "This eval"
              : entry.source === "suite"
                ? "Suite default"
                : "Default"}
          </SourceNote>
        </div>
      ))}
    </dl>
  );
}
