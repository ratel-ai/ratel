import { cn } from "@ratel/design-system/cn";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  HeartPulse,
  History,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { StepGlyph } from "@/components/console/health/kinds";
import { TurnAfter, TurnAsked } from "@/components/console/traces/TurnConversation";
import { TurnLinkedPanel } from "@/components/console/traces/TurnLinkedPanel";
import { formatDuration } from "@/lib/readings/trace-signals/claims";
import { GROUP_OF } from "@/lib/readings/trace-signals/hallucinations/kinds";
import {
  agentHealthHref,
  evidenceTraceHref,
  turnEventAnchor,
  turnTracesHref,
} from "@/lib/readings/trace-signals/view";
import { formatDuration as formatLongDuration } from "@/lib/synthesis/traces/v2/format";
import type { TurnMarker } from "@/lib/views/health/hallucinations/turn-markers";
import type { AfterSearch, CallAfterSearch } from "@/lib/views/traces/after-search";
import type { TurnConversation as Conversation } from "@/lib/views/traces/sentiment/example";
import type { TurnDetail, TurnDetailCall } from "@/lib/views/traces/turn-detail";

/**
 * One turn in Traces, call by call: what the agent searched for and what came
 * back, which tool or skill it ran and from which rank, how long it took, and
 * the error text when it failed. The call an Agent health example is about is
 * outlined and scrolled to (neutrally: the call may be clutter, not a fault).
 * Each call links its trace waterfall when Traces holds one.
 */

const TIME = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const SOURCE_TEXT: Record<string, string> = {
  declared: "Turn declared by the SDK",
  inferred: "Turn inferred from timing",
  otlp: "Turn read from a trace",
};

export interface TurnDetailViewProps {
  projectId: string;
  turn: TurnDetail;
  /** The call to ring and scroll to (a `trace_events.id`). */
  focusEventId: string | null;
  /** The session replay of this turn's session. */
  sessionHref?: string | null;
  /** What was asked, replied and said next; null while both flags that show it are off, or nothing was read. */
  conversation?: Conversation | null;
  /** The turn's hallucinations, each on the call it sits on; empty while `hallucinationDetection` is off. */
  hallucinations?: readonly TurnMarker[];
  /** What the session ran next, when the turn ended on a search. */
  afterSearch?: AfterSearch | null;
  /** Inside a Panel: without the page's own navigation, which would leave the list. */
  embedded?: boolean;
}

export function TurnDetailView({
  projectId,
  turn,
  focusEventId,
  sessionHref = null,
  conversation = null,
  hallucinations = [],
  afterSearch = null,
  embedded = false,
}: TurnDetailViewProps) {
  // A false "done" (either completion kind) is about the reply: it shows there, when the reply is on the
  // page; else on the call it was stored on.
  const onReply = conversation?.reply
    ? hallucinations.filter((marker) => GROUP_OF[marker.kind] === "completion")
    : [];
  const onCalls = hallucinations.filter((marker) => !onReply.includes(marker));
  const started = new Date(turn.startedAt);
  const spanMs = Math.max(0, new Date(turn.endedAt).getTime() - started.getTime());
  const errors = turn.calls.filter((call) => call.outcome === "error").length;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6" data-turn-detail={turn.id}>
      <header className="pixel-header flex flex-wrap items-end justify-between gap-4 border-b border-forest-300 pb-6">
        <div className="min-w-0">
          {embedded ? null : <div className="eyebrow">Traces · Turn</div>}
          <h1
            className={cn(
              "mt-1 font-display font-bold tracking-tight text-cream",
              embedded ? "text-lg" : "text-2xl",
            )}
          >
            A turn on {DAY.format(started)}, {TIME.format(started)} UTC
          </h1>
          <p className="mt-2 text-sm text-warm-muted">
            {turn.calls.length} {turn.calls.length === 1 ? "call" : "calls"} over{" "}
            {formatDuration(spanMs)}
            {errors > 0 && (
              <span className="text-coral">
                {" "}
                · {errors} {errors === 1 ? "error" : "errors"}
              </span>
            )}
            {" · "}
            {SOURCE_TEXT[turn.turnSource] ?? "Turn"}
          </p>
          <p className="mt-1 text-[12px] text-warm-muted">
            Session{" "}
            <span className="font-mono text-cream-dim [overflow-wrap:anywhere]">
              {turn.sessionId}
            </span>
          </p>
        </div>
        <nav aria-label="Turn navigation" className="flex flex-wrap items-center gap-2 text-[12px]">
          {embedded ? null : (
            <>
              <NavLink href={agentHealthHref(projectId)}>
                <HeartPulse className="size-3.5" aria-hidden />
                Agent health
              </NavLink>
              <NavLink href={`/project/${encodeURIComponent(projectId)}/traces`}>
                All traces
              </NavLink>
            </>
          )}
          {sessionHref && (
            <NavLink href={sessionHref}>
              <History className="size-3.5" aria-hidden />
              Replay session
            </NavLink>
          )}
        </nav>
      </header>

      {turn.linked && <TurnLinkedPanel linked={turn.linked} hideAsked={conversation != null} />}
      {conversation && (
        <TurnAsked conversation={conversation} fallback={turn.linked?.asked ?? null} />
      )}

      <ol aria-label="Calls in this turn" className="flex flex-col gap-2.5">
        {turn.calls.map((call) => (
          <CallRow
            key={call.ordinal}
            projectId={projectId}
            call={call}
            focused={call.eventId === focusEventId}
            markers={onCalls.filter((marker) => marker.stepOrdinal === call.ordinal)}
            afterSearch={afterSearch?.ordinal === call.ordinal ? afterSearch : null}
            seeAll={!embedded}
          />
        ))}
      </ol>
      {turn.calls.length === 0 && (
        <p className="rounded-lg border border-dashed border-forest-300 px-4 py-6 text-center text-sm text-warm-muted">
          No calls were kept for this turn.
        </p>
      )}
      {/* After the calls, as it happened: the reply, then what came next. */}
      {conversation && (
        <TurnAfter
          conversation={conversation}
          afterReply={
            onReply.length > 0 ? (
              <ul className="flex flex-col gap-2" aria-label="Hallucinations in the reply">
                {onReply.map((marker) => (
                  <li key={`${marker.kind}:${marker.stepOrdinal}`}>
                    <HallucinationMarker marker={marker} seeAll={!embedded} />
                  </li>
                ))}
              </ul>
            ) : null
          }
        />
      )}

      {!embedded && (turn.previousTurnId || turn.nextTurnId) && (
        <nav
          aria-label="Same session"
          className="flex items-center justify-between gap-3 border-t border-forest-300 pt-4 text-[13px]"
        >
          {turn.previousTurnId ? (
            <NavLink href={turnTracesHref(projectId, turn.previousTurnId)}>
              <ArrowLeft className="size-3.5" aria-hidden />
              Previous turn in this session
            </NavLink>
          ) : (
            <span />
          )}
          {turn.nextTurnId && (
            <NavLink href={turnTracesHref(projectId, turn.nextTurnId)}>
              Next turn in this session
              <ArrowRight className="size-3.5" aria-hidden />
            </NavLink>
          )}
        </nav>
      )}
    </div>
  );
}

/** One hallucination, where it happened: the kind, what the trace shows, and the way to every case of it. */
function HallucinationMarker({ marker, seeAll }: { marker: TurnMarker; seeAll: boolean }) {
  return (
    <div
      className="rounded-lg border border-coral/40 bg-coral/5 px-3 py-2 text-[12px] leading-5"
      data-hallucination-marker={marker.kind}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1.5 font-medium text-coral">
          <TriangleAlert className="size-3.5" aria-hidden />
          Hallucination
        </span>
        <span className="text-cream">{marker.label}</span>
        {seeAll ? (
          <Link
            href={marker.href}
            className="ml-auto inline-flex items-center gap-1 rounded text-cream-dim underline decoration-forest-300 underline-offset-4 outline-none hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/60"
          >
            See all like this
            <ArrowUpRight className="size-3" aria-hidden />
          </Link>
        ) : null}
      </p>
      <p className="mt-0.5 text-cream-dim [overflow-wrap:anywhere]">{marker.detail}</p>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-md border border-forest-300 px-2.5 py-1.5 text-cream-dim outline-none transition-colors hover:bg-forest hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/60"
    >
      {children}
    </Link>
  );
}

function CallRow({
  projectId,
  call,
  focused,
  markers,
  afterSearch,
  seeAll,
}: {
  projectId: string;
  call: TurnDetailCall;
  focused: boolean;
  markers: readonly TurnMarker[];
  afterSearch: AfterSearch | null;
  seeAll: boolean;
}) {
  const glyph = call.kind === "search" ? "search" : call.targetType === "skill" ? "skill" : "tool";
  const failed = call.outcome === "error";
  return (
    <li
      id={turnEventAnchor(call.eventId)}
      data-turn-call={call.ordinal}
      data-focused={focused ? "true" : undefined}
      className={cn(
        "scroll-mt-24 rounded-xl border bg-forest-600/40 px-4 py-3.5",
        focused
          ? "border-cream-dim/60 bg-forest-600/80 shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-cream)_6%,transparent)]"
          : "border-forest-300",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="flex min-w-0 items-center gap-2 text-sm text-cream">
          <StepGlyph glyph={glyph} />
          <span className="text-warm-muted">{call.ordinal}.</span>
          {call.kind === "search" ? <SearchTitle call={call} /> : <InvokeTitle call={call} />}
        </p>
        <p className="font-mono text-[11px] tabular-nums text-warm-muted">
          {TIME.format(new Date(call.occurredAt))}
          {call.gapMs !== null && call.gapMs > 0 && <span> · +{formatDuration(call.gapMs)}</span>}
        </p>
      </div>
      {focused && (
        <p className="mt-1 text-[12px] font-medium text-cream-dim">
          The call this example is about
        </p>
      )}
      {markers.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2" aria-label="Hallucinations on this call">
          {markers.map((marker) => (
            <li key={marker.kind}>
              <HallucinationMarker marker={marker} seeAll={seeAll} />
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-[12px] leading-5">
        {call.kind === "search" ? (
          <>
            <dt className="text-warm-muted">Listed</dt>
            <dd className="text-cream-dim">
              {call.hitCount ?? 0} {call.hitCount === 1 ? "result" : "results"}
              {call.hits.length > 0 && (
                <ol className="mt-1 flex flex-col gap-0.5" aria-label="Top results">
                  {call.hits.map((hit) => (
                    <li key={hit.rank} className="flex gap-2 font-mono text-[11px]">
                      <span className="w-6 shrink-0 text-right tabular-nums text-warm-muted">
                        #{hit.rank}
                      </span>
                      <span className="min-w-0 text-cream-dim [overflow-wrap:anywhere]">
                        {hit.id}
                      </span>
                      {hit.score !== null && (
                        <span className="tabular-nums text-warm-muted">{hit.score.toFixed(2)}</span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </dd>
            {afterSearch && (
              <>
                <dt className="text-warm-muted">Next</dt>
                <dd className="text-cream-dim" data-after-search="">
                  {afterSearch.next ? (
                    <>
                      ran <AfterCall call={afterSearch.next} />
                      {afterSearch.listed ? (
                        <>
                          , and <AfterCall call={afterSearch.listed} from=" from this list" />
                        </>
                      ) : null}
                    </>
                  ) : (
                    "nothing more was run in this session"
                  )}
                </dd>
              </>
            )}
          </>
        ) : (
          <>
            {call.offeredRank !== null && (
              <>
                <dt className="text-warm-muted">Picked from</dt>
                <dd className="tabular-nums text-cream-dim">
                  #{call.offeredRank} in an earlier search
                </dd>
              </>
            )}
            <dt className="text-warm-muted">Outcome</dt>
            <dd className={failed ? "text-coral" : "text-cream-dim"}>
              {call.outcome === "error"
                ? "Failed"
                : call.outcome === "ok"
                  ? "Finished"
                  : "No end recorded"}
              {call.tookMs !== null && (
                <span className="text-warm-muted"> · {formatDuration(call.tookMs)}</span>
              )}
            </dd>
            {call.errorMessage && (
              <>
                <dt className="text-warm-muted">Error</dt>
                <dd className="whitespace-pre-wrap font-mono text-[11px] text-coral/90 [overflow-wrap:anywhere]">
                  {call.errorMessage}
                </dd>
              </>
            )}
          </>
        )}
        <dt className="text-warm-muted">Event</dt>
        <dd className="flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-warm-muted">
          <span>{call.eventType}</span>
          <span className="[overflow-wrap:anywhere]">{call.eventId}</span>
          {call.traceId && (
            <Link
              href={`${evidenceTraceHref(projectId, call.traceId)}${call.spanId ? `?span=${encodeURIComponent(call.spanId)}` : ""}`}
              className="inline-flex items-center gap-1 rounded font-sans text-[12px] text-cream-dim underline decoration-forest-300 underline-offset-4 outline-none hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/60"
            >
              Open trace
              <ArrowUpRight className="size-3" aria-hidden />
            </Link>
          )}
        </dd>
      </dl>
    </li>
  );
}

/** To the minute from one minute on: how long after is a rough thing. */
const wholeMinutes = (ms: number): number => (ms < 60_000 ? ms : Math.round(ms / 60_000) * 60_000);

function AfterCall({ call, from = "" }: { call: CallAfterSearch; from?: string }) {
  return (
    <>
      <span className="font-mono text-[11px] text-cream [overflow-wrap:anywhere]">{call.id}</span>
      {`${from} ${formatLongDuration(wholeMinutes(call.afterMs))} later`}
    </>
  );
}

function SearchTitle({ call }: { call: TurnDetailCall }) {
  const query = call.query;
  return (
    <span className="min-w-0">
      searched{" "}
      {query?.state === "captured" ? (
        <span className="text-cream [overflow-wrap:anywhere]">&ldquo;{query.text}&rdquo;</span>
      ) : (
        <em className="text-warm-muted">
          {query?.state === "expired" ? "query expired" : "query not captured"}
        </em>
      )}
    </span>
  );
}

function InvokeTitle({ call }: { call: TurnDetailCall }) {
  return (
    <span className="min-w-0">
      {call.targetType === "skill" ? "ran skill" : "called"}{" "}
      <span className="font-mono text-[13px] text-cream [overflow-wrap:anywhere]">
        {call.targetId ?? "unknown"}
      </span>
    </span>
  );
}
