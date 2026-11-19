import { Badge, StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { Section } from "@ratel/design-system/section";
import { Callout, EmptyState, Skeleton } from "@ratel/design-system/states";
import {
  ArrowUpRight,
  ChevronRight,
  CircleCheck,
  EyeOff,
  MessageSquare,
  RefreshCw,
  Search,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SIGNAL_KIND_ICONS } from "@/components/console/health/kinds";
import { Calculating } from "@/components/console/health/v2/Calculating";
import { HealthScore, type ScoreFix } from "@/components/console/health/v2/HealthScore";
import { scoreCopy } from "@/components/console/health/v2/health-score-model";
import type { HealthScoreView } from "@/lib/readings/trace-signals/health-score";
import { type RatelView, useRatelView } from "../../shell/bridge";
import { mountView } from "../../shell/mount";
import type { ToolFailure, ToolSuccess } from "../../shell/state";
import { ViewFrame } from "../../shell/view-frame";
import view from "./bindings";
import {
  applyHiddenEdit,
  cardState,
  type FreshnessData,
  fixPrompt,
  type HealthData,
  type HealthRow,
  type HiddenEdits,
  type HiddenIssue,
  hiddenIssuesShown,
  type Issue,
  NO_HIDDEN_EDITS,
  nextFixes,
  readingAge,
  readingDone,
  rowMembers,
  rowOfIssue,
  rowsShown,
  type ScoreData,
  withHealthScore,
} from "./model";

/**
 * The health card (RW-10), as approved in RW-9: "is my agent OK?" in one view.
 *
 * Compact first (the score in one line and the three rows worth the most),
 * and the console's own Health score card with every row a click away. The
 * rows are the console's (one per kind of issue, with the points fixing all
 * of it wins back), sent by the server, so the card and the page agree. A
 * row opens in the DS Panel: which of its issues, what it costs, what fixing
 * it wins back, what to do, and its example turns read through
 * list_issue_examples. Slow tools
 * hide as slow by design through set_health_signal_hidden, a write the host
 * confirms; the card re-reads get_agent_health once it answers. A stale or
 * missing reading offers request_analysis, then follows get_analysis_freshness
 * until the new reading is in.
 */

const PEEK = "issue:";
const COMPACT = 3;
const POLL_MS = 10_000;
const POLL_TIMES = 30;

const time = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const count = new Intl.NumberFormat("en");

function windowWords(days: number): string {
  return days === 7 ? "This week" : `Last ${days} days`;
}

/** An issue's title with what it is about, when the title does not say: "Slow tool: export_project_report". */
function named(issue: Issue): string {
  return issue.subject.label && !issue.title.includes(issue.subject.label)
    ? `${issue.title}: ${issue.subject.label}`
    : issue.title;
}

/** HealthScore takes the page's view; the card has each issue's points instead of the parts. */
function asView(score: ScoreData): HealthScoreView {
  return { ...score, parts: {} };
}

/* - Asking for a fresh reading ---------------------------------------------- */

type ReadNow =
  | { status: "idle" }
  | { status: "asking" }
  | { status: "reading"; since: number }
  | { status: "cooldown" }
  | { status: "failed"; message: string };

/**
 * request_analysis, then get_analysis_freshness every 10 s until the reading
 * is done, then the tool that rendered the card again. Gives up quietly after
 * five minutes: the reading goes on, the card just stops watching.
 */
/** The time, read outside render and again every `everyMs`. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

function useReadNow(ratel: RatelView, onFresh: () => Promise<void>): [ReadNow, () => void] {
  const [state, setState] = useState<ReadNow>({ status: "idle" });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  async function ask() {
    setState({ status: "asking" });
    const since = Date.now();
    const read = await ratel.callTool<{ queued: boolean; reason?: string }>("request_analysis", {
      what: "health",
    });
    if (!live.current) return;
    if (!read.ok) return setState({ status: "failed", message: read.error.message });
    if (!read.value.data.queued) return setState({ status: "cooldown" });
    setState({ status: "reading", since });
    for (let attempt = 0; attempt < POLL_TIMES; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (!live.current) return;
      const fresh = await ratel.callTool<FreshnessData>("get_analysis_freshness", {
        section: "health",
      });
      if (!live.current) return;
      if (fresh.ok && readingDone(fresh.value.data, since)) {
        await onFresh();
        if (live.current) setState({ status: "idle" });
        return;
      }
    }
    if (live.current) setState({ status: "idle" });
  }

  return [state, () => void ask()];
}

function ReadNowLine({
  state,
  onAsk,
  stale,
  age,
}: {
  state: ReadNow;
  onAsk: () => void;
  stale: boolean;
  age: string | null;
}) {
  if (state.status === "reading") {
    return (
      <Callout tone="info" title="Reading your latest runs">
        The card refreshes on its own when the new reading is in, usually within a few minutes.
      </Callout>
    );
  }
  if (state.status === "cooldown")
    return (
      <Callout tone="info">
        A reading was asked for in the last 10 minutes. It is on its way.
      </Callout>
    );
  if (state.status === "failed")
    return (
      <Callout tone="danger" title="Could not ask for a reading">
        {state.message}
      </Callout>
    );
  if (!stale) return null;
  return (
    <Callout
      tone="warning"
      title={`This reading is old${age ? `: ${age}` : ""}`}
      action={
        <Button size="sm" variant="secondary" loading={state.status === "asking"} onClick={onAsk}>
          <RefreshCw aria-hidden className="size-3.5" />
          Read now
        </Button>
      }
    >
      Newer runs are not in it yet.
    </Callout>
  );
}

/* - Pieces ------------------------------------------------------------------ */

function Header({ data, ratel, age }: { data: HealthData; ratel: RatelView; age: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="min-w-0 truncate text-xs text-fg-subtle">
        <span className="font-medium text-fg">Agent health</span> · {windowWords(data.windowDays)} ·{" "}
        {count.format(data.turns)} turns
        {age ? ` · ${age}` : ""}
      </p>
      <Button variant="ghost" size="sm" onClick={() => ratel.openInConsole(data.href)}>
        Open in Ratel
        <ArrowUpRight aria-hidden className="size-3.5" />
      </Button>
    </div>
  );
}

function Points({ points, early = false }: { points: number | null; early?: boolean }) {
  if (early) return <span className="shrink-0 text-xs text-fg-subtle">Too early</span>;
  if (points === null) return null;
  return points >= 1 ? (
    <span className="shrink-0 text-ui font-medium text-success tabular-nums">
      +{points}&nbsp;{points === 1 ? "pt" : "pts"}
    </span>
  ) : (
    <span className="shrink-0 text-ui text-fg-subtle">&lt;1&nbsp;pt</span>
  );
}

/** One of the console's rows: its icon, its title, what it is about and what fixing all of it is worth. */
function RowItem({
  row,
  index,
  onOpen,
}: {
  row: HealthRow;
  index: number;
  onOpen: (row: HealthRow) => void;
}) {
  const Icon = SIGNAL_KIND_ICONS[row.kind];
  const about = row.about;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row)}
        data-health-row={row.key}
        className="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 py-2 text-left outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="w-3 shrink-0 text-xs text-fg-faint tabular-nums">{index + 1}</span>
        {Icon ? (
          <Icon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-fg-muted" />
        ) : null}
        {/* The title names the kind ("Slow tool"); beside it, which tools or how many. */}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 shrink truncate text-ui text-fg">{row.title}</span>
          {about && !row.title.includes(about) ? (
            <span className="min-w-0 shrink-[3] truncate font-mono text-xs text-fg-subtle">
              {about}
            </span>
          ) : null}
        </span>
        <Points points={row.points} early={row.tone === "early"} />
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 text-fg-faint group-hover:text-fg-muted"
        />
      </button>
    </li>
  );
}

function RowList({
  rows,
  onOpen,
}: {
  rows: readonly HealthRow[];
  onOpen: (row: HealthRow) => void;
}) {
  return (
    <ol className="flex flex-col">
      {rows.map((row, index) => (
        <RowItem key={row.key} row={row} index={index} onOpen={onOpen} />
      ))}
    </ol>
  );
}

/** Slow tools hidden as slow by design, each with "Show again". */
function HiddenList({
  hidden,
  onShow,
  busy,
}: {
  hidden: readonly HiddenIssue[];
  onShow: (id: string) => void;
  busy: string | null;
}) {
  if (hidden.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-3">
      <h3 className="text-xs font-medium text-fg-subtle">Hidden as slow by design</h3>
      <ul className="flex flex-col">
        {hidden.map((item) => (
          <li key={item.id} className="flex items-center gap-2.5 py-1 text-ui">
            <EyeOff aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-fg-faint" />
            <span className="min-w-0 flex-1 truncate text-fg-muted">{item.label}</span>
            <Button
              variant="ghost"
              size="sm"
              loading={busy === item.id}
              onClick={() => onShow(item.id)}
            >
              Show again
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The score in one line: number, band, the headline and the goal. An early reading says so, and shows no change yet, as the page does. */
function ScoreStrip({
  score,
  early,
  progress,
}: {
  score: ScoreData;
  early: boolean;
  progress: HealthData["progress"];
}) {
  const copy = scoreCopy(asView(score));
  const tone =
    copy.tone === "success"
      ? "text-success"
      : copy.tone === "warning"
        ? "text-warning"
        : "text-danger";
  return (
    <section
      aria-label="Health score"
      data-health-score={score.value}
      className="flex items-center gap-4 rounded-lg border border-line bg-raised px-4 py-3"
    >
      <div className="flex shrink-0 items-baseline gap-1">
        <span
          className={cn("text-3xl leading-none font-semibold tracking-tight tabular-nums", tone)}
        >
          {score.value}
        </span>
        <span className="text-xs text-fg-subtle">/100</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-fg">
          {copy.headline}
          <StatusDot
            tone={copy.tone}
            label={copy.band}
            className="text-xs font-medium text-fg-muted"
          />
          {early ? <Calculating progress={progress} /> : null}
        </p>
        <p className="text-xs text-fg-muted">
          {copy.goal}
          {copy.change && !early ? (
            <span className="text-fg-subtle"> {copy.change.text}.</span>
          ) : null}
        </p>
      </div>
    </section>
  );
}

function Healthy() {
  return (
    <div className="flex items-center gap-2 py-2 text-ui text-fg-muted">
      <CircleCheck aria-hidden className="size-4 text-success" />
      Nothing to fix right now.
    </div>
  );
}

/* - The issue's panel -------------------------------------------------------- */

interface StoryStep {
  kind: "search" | "invoke";
  query?: string | null;
  listed?: number;
  toolId?: string;
  pickedRank?: number | null;
  outcome?: "ok" | "error" | "unknown";
  tookMs?: number | null;
  flag: string | null;
}

interface ExamplesData {
  locked: boolean;
  examples: {
    id: string;
    total: number;
    turns: { turnId: string; startedAt: string; steps: StoryStep[]; href: string }[];
  }[];
  contentWithheld?: boolean;
}

function Step({ step }: { step: StoryStep }) {
  const flagged = step.flag !== null;
  const Icon = step.kind === "search" ? Search : Wrench;
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-md px-2 py-1.5 text-xs",
        flagged ? "bg-accent-subtle ring-1 ring-accent-mark" : "",
      )}
    >
      <Icon aria-hidden strokeWidth={1.5} className="mt-px size-3.5 shrink-0 text-fg-muted" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {step.kind === "search" ? (
          <span className="text-fg">
            Searched{" "}
            {step.query ? (
              <span>“{step.query}”</span>
            ) : (
              <span className="text-fg-subtle">(words not shown)</span>
            )}
            <span className="text-fg-subtle"> · listed {step.listed ?? 0}</span>
          </span>
        ) : (
          <span className="text-fg">
            Ran <code className="font-mono">{step.toolId}</code>
            {step.pickedRank ? (
              <span className="text-fg-subtle"> · picked #{step.pickedRank}</span>
            ) : null}
            {typeof step.tookMs === "number" ? (
              <span className="text-fg-subtle">
                {" "}
                ·{" "}
                {step.tookMs >= 1000 ? `${(step.tookMs / 1000).toFixed(1)} s` : `${step.tookMs} ms`}
              </span>
            ) : null}
          </span>
        )}
        {flagged ? <span className="font-medium text-accent">{step.flag}</span> : null}
      </span>
      {step.kind === "invoke" && step.outcome === "error" ? (
        <Badge tone="danger">Error</Badge>
      ) : null}
    </li>
  );
}

/** The issue's example turns, read when its panel opens (never with the card): a turn can hold what a user typed. */
function Examples({ ratel, issue }: { ratel: RatelView; issue: Issue }) {
  const [answer, setAnswer] = useState<{
    id: string;
    data: ExamplesData | null;
    error: ToolFailure | null;
  } | null>(null);
  useEffect(() => {
    let live = true;
    void ratel
      .callTool<ExamplesData>("list_issue_examples", { issueIds: [issue.id] })
      .then((read) => {
        if (live)
          setAnswer(
            read.ok
              ? { id: issue.id, data: read.value.data, error: null }
              : { id: issue.id, data: null, error: read.error },
          );
      });
    return () => {
      live = false;
    };
    // Only another issue reads again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.id]);

  const current = answer?.id === issue.id ? answer : null;
  if (!current) {
    return (
      <div className="flex flex-col gap-2" aria-busy>
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (current.error)
    return (
      <Callout tone="danger" title="Could not read the examples">
        {current.error.message}
      </Callout>
    );
  if (current.data?.locked)
    return <Callout tone="info">This plan shows no example turns. A paid plan shows them.</Callout>;
  const mine = current.data?.examples.find((item) => item.id === issue.id);
  if (!mine || mine.turns.length === 0)
    return <p className="text-ui text-fg-subtle">No example turns in this window.</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-subtle">
        {mine.turns.length} of {count.format(mine.total)} turns, newest first.
        {current.data?.contentWithheld ? " What users typed is not shown." : ""}
      </p>
      <ol className="flex flex-col gap-3">
        {mine.turns.map((turn) => (
          <li key={turn.turnId} className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-xs text-fg-muted tabular-nums">
                {time.format(new Date(turn.startedAt))}
              </span>
              <Button variant="ghost" size="sm" onClick={() => ratel.openInConsole(turn.href)}>
                Open trace
                <ArrowUpRight aria-hidden className="size-3.5" />
              </Button>
            </div>
            <ol className="flex flex-col gap-0.5">
              {turn.steps.map((step, index) => (
                <Step key={index} step={step} />
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What fixing is worth: the whole row, and the open issue alone when the row
 * stands for several. "Several" is the row's own count, not how many of its
 * issues this result carries: the row's points are for all of them.
 */
function Worth({ row, issue }: { row: HealthRow; issue: Issue | null }) {
  const words = (points: number) =>
    points >= 1 ? (
      <span className="font-medium text-success">
        +{points} {points === 1 ? "point" : "points"}
      </span>
    ) : (
      "Less than a point"
    );
  const several = row.memberIds.length > 1;
  if (row.tone === "early") return null;
  return (
    <>
      {row.points !== null ? (
        <>
          <dt className="text-fg-subtle">
            {several ? `Fixing all ${row.memberIds.length}` : "Fixing it"}
          </dt>
          <dd className="text-fg">{words(row.points)}</dd>
        </>
      ) : null}
      {several && issue && issue.points !== null ? (
        <>
          <dt className="text-fg-subtle">This one alone</dt>
          <dd className="text-fg">{words(issue.points)}</dd>
        </>
      ) : null}
    </>
  );
}

/** The row's issues, to pick the one the panel shows. */
function Members({
  members,
  openId,
  onPick,
}: {
  members: readonly Issue[];
  openId: string;
  onPick: (id: string) => void;
}) {
  return (
    <ul className="flex flex-col" aria-label="Issues of this kind">
      {members.map((member) => (
        <li key={member.id}>
          <button
            type="button"
            aria-pressed={member.id === openId}
            onClick={() => onPick(member.id)}
            className={cn(
              "-mx-2 flex w-[calc(100%+1rem)] items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-ui outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus",
              member.id === openId ? "bg-hover text-fg" : "text-fg-muted",
            )}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {member.subject.label || member.title}
            </span>
            <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{member.figure}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface OpenRow {
  row: HealthRow;
  /** The row's issues the result carries, worst first. */
  members: readonly Issue[];
  /** The one the panel shows: the one asked for, else the worst. */
  issue: Issue | null;
}

function IssuePanel({
  ratel,
  open,
  consoleHref,
  onClose,
  onStep,
  onPick,
  onHide,
  hiding,
}: {
  ratel: RatelView;
  open: OpenRow | null;
  consoleHref: string;
  onClose: () => void;
  onStep: (delta: number) => void;
  onPick: (id: string) => void;
  onHide: (issue: Issue) => void;
  hiding: boolean;
}) {
  // Keep the last row's body while the panel animates out.
  const [shown, setShown] = useState<OpenRow | null>(open);
  if (open && (open.row !== shown?.row || open.issue !== shown?.issue)) setShown(open);
  const current = open ?? shown;
  const body = current?.issue ?? null;
  const several = (current?.members.length ?? 0) > 1;
  // What the host did with "Ask the agent", for the issue it was asked on.
  const [asked, setAsked] = useState<{ id: string; status: "sending" | "sent" | "refused" } | null>(
    null,
  );
  const ask = asked && body && asked.id === body.id ? asked.status : null;
  async function askAgent(target: Issue) {
    setAsked({ id: target.id, status: "sending" });
    const taken = await ratel.askAgent(fixPrompt(target));
    setAsked({ id: target.id, status: taken ? "sent" : "refused" });
  }
  const about = current?.row.about ?? null;
  return (
    <Panel
      open={open !== null}
      onOpenChange={(next) => (next ? undefined : onClose())}
      title={current?.row.title ?? ""}
      subtitle={
        current
          ? [several ? about : (body?.subject.label ?? about), current.row.figure.display]
              .filter(Boolean)
              .join(" · ")
          : undefined
      }
      onPrevious={() => onStep(-1)}
      onNext={() => onStep(1)}
      actions={
        current ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => ratel.openInConsole(body?.href ?? consoleHref)}
          >
            Open in Ratel
          </Button>
        ) : null
      }
    >
      {current ? (
        <div className="flex flex-col gap-5">
          {several && body ? (
            <Members members={current.members} openId={body.id} onPick={onPick} />
          ) : null}
          {body ? (
            <>
              <div className="flex flex-col gap-3">
                <p className="text-sm text-fg">{body.claim}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-ui">
                  <dt className="text-fg-subtle">Costs</dt>
                  <dd className="text-fg">{body.cost}</dd>
                  <Worth row={current.row} issue={body} />
                </dl>
                <Callout tone="info" title="What to do">
                  {body.whatToDo}
                </Callout>
                {body.caveat ? <p className="text-xs text-fg-subtle">{body.caveat}</p> : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={ask === "sending"}
                    onClick={() => void askAgent(body)}
                  >
                    <MessageSquare aria-hidden className="size-3.5" />
                    Ask the agent to fix it
                  </Button>
                  {body.hideable ? (
                    <Button variant="ghost" size="sm" loading={hiding} onClick={() => onHide(body)}>
                      <EyeOff aria-hidden className="size-3.5" />
                      Hide as slow by design
                    </Button>
                  ) : null}
                </div>
                {ask === "sent" ? <p className="text-xs text-fg-muted">Sent to the chat.</p> : null}
                {ask === "refused" ? (
                  <Callout tone="warning" title="The chat didn't take the message">
                    <p>Copy this and send it yourself:</p>
                    <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-fg select-all">
                      {fixPrompt(body)}
                    </pre>
                  </Callout>
                ) : null}
              </div>
              <Section title="Example turns">
                <Examples ratel={ratel} issue={body} />
              </Section>
            </>
          ) : (
            // Its issues were cut from this result (the tool's limit): the page has them.
            <Callout tone="info">
              This result does not carry the details of these issues. Open it in Ratel to see them.
            </Callout>
          )}
        </div>
      ) : null}
    </Panel>
  );
}

/* - The card ----------------------------------------------------------------- */

function Message({
  data,
  ratel,
  readNow,
  onAsk,
}: {
  data: HealthData;
  ratel: RatelView;
  readNow: ReadNow;
  onAsk: () => void;
}) {
  const state = cardState(data);
  if (state.kind !== "message") return null;
  const reading = readNow.status === "reading";
  const action =
    state.action === "setup" ? (
      <Button size="sm" onClick={() => ratel.openInConsole(data.href)}>
        Set up in Ratel
      </Button>
    ) : state.action === "read" && !reading && readNow.status !== "cooldown" ? (
      <Button size="sm" variant="secondary" loading={readNow.status === "asking"} onClick={onAsk}>
        Read now
      </Button>
    ) : state.action === "open" ? (
      <Button size="sm" variant="secondary" onClick={() => ratel.openInConsole(data.href)}>
        Open in Ratel
      </Button>
    ) : null;
  const description = reading
    ? "A fresh reading is on its way. The card refreshes on its own when it is in."
    : readNow.status === "cooldown"
      ? "A reading was asked for in the last 10 minutes. It is on its way."
      : state.body;
  return (
    <EmptyState
      emblem={!state.working && !reading}
      working={state.working || reading}
      title={state.title}
      description={description}
      action={action}
    />
  );
}

function Card({ result }: { result: ToolSuccess<HealthData> }) {
  const ratel = useRatelView<HealthData>() as RatelView;
  const peek = usePeek();
  const [data, setData] = useState<HealthData>(() => withHealthScore(result.data, result.view));
  const [full, setFull] = useState(false);
  // What the host confirmed while the re-read is on its way (or when it fails).
  const [edits, setEdits] = useState<HiddenEdits>(NO_HIDDEN_EDITS);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  // A new result from the host (the agent called the tool again) replaces what the card shows.
  const [seen, setSeen] = useState(result.data);
  if (seen !== result.data) {
    setSeen(result.data);
    setData(withHealthScore(result.data, result.view));
  }

  /** The tool that rendered the card, read again with the same arguments. */
  async function reread() {
    const tool = ratel.state.toolName ?? "get_agent_health";
    const read = await ratel.callTool<HealthData>(tool, ratel.state.input ?? {});
    if (read.ok) setData(withHealthScore(read.value.data, read.value.view));
  }
  const [readNow, askReading] = useReadNow(ratel, reread);
  // The reading's age, against a clock read outside render and kept fresh by the minute.
  const now = useNow(60_000);

  const rows = useMemo(() => rowsShown(data, edits), [data, edits]);
  const hidden = useMemo(() => hiddenIssuesShown(data, edits), [data, edits]);

  // A panel opens on one issue (`issue:<id>`), as on the page: its row, with that issue picked.
  const openId = peek.id?.startsWith(PEEK) ? peek.id.slice(PEEK.length) : null;
  const openRow = useMemo<OpenRow | null>(() => {
    const row = rowOfIssue(rows, openId);
    if (!row) return null;
    const members = rowMembers(row, data);
    return {
      row,
      members,
      issue: members.find((member) => member.id === openId) ?? members[0] ?? null,
    };
  }, [rows, openId, data]);
  const openIssue = openRow?.issue ?? null;
  const lastContext = useRef<string | null>(null);
  useEffect(() => {
    // Tell the model which issue the user is looking at, without a message.
    const key = openIssue?.id ?? null;
    if (key === lastContext.current) return;
    lastContext.current = key;
    if (openIssue)
      void ratel.setContext(
        `The user opened the Agent health issue "${named(openIssue)}" (id ${openIssue.id}).`,
        { issueId: openIssue.id },
      );
  }, [openIssue, ratel]);

  const age = readingAge(data.computedAt, now);
  const state = cardState(data);
  if (state.kind === "message") {
    return (
      <div className="flex flex-col gap-4">
        <Header data={data} ratel={ratel} age={age.text} />
        <Message data={data} ratel={ratel} readNow={readNow} onAsk={askReading} />
      </div>
    );
  }

  const openIssueId = (id: string) => peek.open(`${PEEK}${id}`);
  /** A row opens on its worst issue the result carries. */
  const open = (row: HealthRow) => openIssueId(rowMembers(row, data)[0]?.id ?? row.memberIds[0]!);
  const step = (delta: number) => {
    if (!openRow) return;
    const next = rows[(rows.indexOf(openRow.row) + delta + rows.length) % rows.length];
    if (next) open(next);
  };

  // A write goes through the host, which may ask the user first; the card changes only once it answers.
  async function setHidden(id: string, hide: boolean, issue?: Issue) {
    setBusy(id);
    const read = await ratel.callTool("set_health_signal_hidden", { signalId: id, hidden: hide });
    if (!read.ok) {
      setBusy(null);
      setNotice({ tone: "danger", text: read.error.message });
      return;
    }
    setEdits((current) => applyHiddenEdit(current, id, hide, issue));
    if (hide && issue) {
      peek.close();
      setNotice({ tone: "success", text: `Hidden as slow by design: ${named(issue)}.` });
    } else {
      setNotice({ tone: "success", text: "Shown again." });
    }
    await reread();
    setBusy(null);
  }

  const score = data.score ?? null;
  // The rows too early to call come last, as on the page; the short list leaves them out, unless they are all there is.
  const sure = rows.filter((row) => row.tone !== "early");
  const top = (sure.length > 0 ? sure : rows).slice(0, COMPACT);
  const next: ScoreFix[] = nextFixes(rows).map((row) => ({
    peek: `${PEEK}${row.memberIds[0]}`,
    title: row.title,
    kind: row.kind,
    points: row.points ?? 0,
  }));
  const locked = data.lockedIssueCount > 0 ? ` ${data.lockedIssueCount} more on a paid plan.` : "";
  const line =
    data.line ?? (sure.length > 0 ? `${sure.length} open, the ones worth the most first.` : null);

  return (
    <div className="flex flex-col gap-4">
      <Header data={data} ratel={ratel} age={age.text} />
      <ReadNowLine state={readNow} onAsk={askReading} stale={age.stale} age={age.text} />
      {notice ? (
        <Callout
          tone={notice.tone}
          title={notice.tone === "danger" ? "Could not change it" : undefined}
        >
          {notice.text}
        </Callout>
      ) : null}

      {full ? (
        <>
          {score ? (
            <HealthScore
              score={asView(score)}
              next={next}
              early={data.early === true}
              progress={data.progress ?? null}
            />
          ) : null}
          <Section
            title="Issues"
            description={rows.length > 0 && line ? `${line}${locked}` : undefined}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setFull(false)}>
                Show less
              </Button>
            }
          >
            {rows.length === 0 ? <Healthy /> : <RowList rows={rows} onOpen={open} />}
            <HiddenList hidden={hidden} onShow={(id) => void setHidden(id, false)} busy={busy} />
          </Section>
        </>
      ) : (
        <>
          {score ? (
            <ScoreStrip
              score={score}
              early={data.early === true}
              progress={data.progress ?? null}
            />
          ) : null}
          {top.length === 0 ? <Healthy /> : <RowList rows={top} onOpen={open} />}
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setFull(true)}>
            {sure.length > COMPACT
              ? `See all ${sure.length} issues and the score`
              : score
                ? "See the full score"
                : "See more"}
            {hidden.length > 0 ? ` · ${hidden.length} hidden` : ""}
          </Button>
        </>
      )}

      <IssuePanel
        ratel={ratel}
        open={openRow}
        consoleHref={data.href}
        onClose={peek.close}
        onStep={step}
        onPick={openIssueId}
        onHide={(issue) => void setHidden(issue.id, true, issue)}
        hiding={busy !== null && busy === openIssue?.id}
      />
    </div>
  );
}

function HealthCard() {
  return <ViewFrame<HealthData>>{(result) => <Card result={result} />}</ViewFrame>;
}

mountView({ name: "health", bindings: view.bindings }, <HealthCard />);
