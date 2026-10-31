"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { Skeleton } from "@ratel/design-system/states";
import { LockKeyhole } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { exampleSubject } from "@/components/console/health/example-copy";
import { memberLabel } from "@/components/console/health/problem-groups";
import { IssueTurn } from "@/components/console/health/v2/IssueTurn";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { EvidenceTurn, SignalView } from "@/lib/readings/trace-signals/view";
import type {
  IssueExamples as IssueExamplesModel,
  IssueExamplesResult,
} from "@/lib/views/health/issue-examples";

/**
 * An issue's example turns, read when the panel opens (never with the page):
 * a turn's story can hold what a user typed. Newest first, five at a time.
 * On a plan without examples, how many turns stand behind the issue and the
 * way to see them.
 */

export type ExamplesState =
  | { status: "loading" }
  | { status: "ready"; locked: boolean; examples: readonly IssueExamplesModel[] }
  | { status: "error"; message: string };

/** One cache per page, so reopening an issue does not read it again. */
export type ExamplesCache = Map<string, ExamplesState>;

const PAGE = 5;

export function examplesUrl(projectId: string, ids: readonly string[]): string {
  return `/api/projects/${encodeURIComponent(projectId)}/health/examples?issues=${ids.map(encodeURIComponent).join(",")}`;
}

function useExamples(
  projectId: string,
  ids: readonly string[],
  enabled: boolean,
  cache: ExamplesCache,
): [ExamplesState, () => void] {
  const key = ids.join(",");
  const [state, setState] = useState<ExamplesState>(() => cache.get(key) ?? { status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // A new set of ids starts from what the cache knows (adjusting state during render, as React advises).
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setState(cache.get(key) ?? { status: "loading" });
  }
  useEffect(() => {
    if (!enabled || key.length === 0) return;
    const known = cache.get(key);
    if (known && known.status === "ready") return;
    const controller = new AbortController();
    fetch(examplesUrl(projectId, key.split(",")), { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as IssueExamplesResult;
        const next: ExamplesState =
          response.ok && body.ok
            ? { status: "ready", locked: body.locked, examples: body.examples }
            : {
                status: "error",
                message: body.ok ? "Couldn't load these examples." : body.message,
              };
        if (next.status === "ready") cache.set(key, next);
        setState(next);
      })
      .catch((error: unknown) => {
        if ((error as { name?: string })?.name !== "AbortError")
          setState({
            status: "error",
            message: "Couldn't load these examples. Try again in a moment.",
          });
      });
    return () => controller.abort();
  }, [projectId, key, enabled, attempt, cache]);
  const retry = () => {
    cache.delete(key);
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  };
  return [state, retry];
}

interface Item {
  signal: SignalView;
  turn: EvidenceTurn;
}

export function IssueExamples({
  projectId,
  members,
  labelTools,
  examplesAllowed,
  upgradeHref,
  cache,
}: {
  projectId: string;
  /** The issues whose turns to show: one, or a row's every member. */
  members: readonly SignalView[];
  /** Name each example's tool: the list mixes several. */
  labelTools: boolean;
  /** False on a plan without example turns: no read, the upsell instead. */
  examplesAllowed: boolean;
  upgradeHref: string | null;
  cache: ExamplesCache;
}) {
  const ids = members.map((member) => member.id);
  const [state, retry] = useExamples(projectId, ids, examplesAllowed, cache);
  const [shown, setShown] = useState(PAGE);
  const total = members.reduce((sum, member) => sum + member.evidence.totalTurns, 0);

  if (!examplesAllowed || (state.status === "ready" && state.locked))
    return <Locked total={total} upgradeHref={upgradeHref} />;
  if (state.status === "loading") {
    return (
      <div aria-busy="true" className="flex flex-col gap-3 py-1" data-issue-examples="loading">
        <span className="sr-only" role="status">
          Loading examples…
        </span>
        {[0, 1, 2].map((index) => (
          <div key={index} aria-hidden className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-2 text-ui text-fg-muted"
        data-issue-examples="error"
      >
        <span>{state.message}</span>
        <Button size="sm" variant="ghost" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }

  const byId = new Map(state.examples.map((entry) => [entry.id, entry]));
  const items: Item[] = members
    .flatMap((signal) => (byId.get(signal.id)?.turns ?? []).map((turn) => ({ signal, turn })))
    .sort((a, b) => b.turn.startedAt.localeCompare(a.turn.startedAt));
  if (items.length === 0) {
    return (
      <p className="text-ui text-fg-muted" data-issue-examples="none">
        No example turns were kept for this one.
      </p>
    );
  }
  const known = Math.max(total, items.length);
  return (
    <div className="flex flex-col gap-1" data-issue-examples={items.length}>
      <p className="text-xs text-fg-subtle tabular-nums">
        {formatCount(items.length)} of {formatCount(known)} {known === 1 ? "turn" : "turns"}, newest
        first
      </p>
      <ul className="flex flex-col">
        {items.slice(0, shown).map(({ signal, turn }) => (
          <IssueTurn
            key={`${signal.id}:${turn.turnId}`}
            projectId={projectId}
            turn={turn}
            kind={signal.kind}
            subject={exampleSubject(signal)}
            toolLabel={labelTools ? memberLabel(signal) : null}
            skillIds={
              new Set(
                signal.subject.chips
                  .filter((chip) => chip.entryKind === "skill")
                  .map((chip) => chip.id),
              )
            }
          />
        ))}
      </ul>
      {items.length > shown ? (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => setShown(items.length)}
        >
          Show all {formatCount(items.length)} examples
        </Button>
      ) : null}
    </div>
  );
}

/** A plan without example turns: how many there are, and where to get them. */
function Locked({ total, upgradeHref }: { total: number; upgradeHref: string | null }) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-raised px-3 py-2.5"
      data-issue-examples="locked"
    >
      <LockKeyhole aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-fg-subtle" />
      <p className="min-w-0 flex-1 text-ui text-fg-muted">
        {total > 0
          ? `${formatCount(total)} ${total === 1 ? "turn stands" : "turns stand"} behind this issue. `
          : ""}
        Example turns are outside this project&apos;s limits.
      </p>
      {upgradeHref ? (
        <Link href={upgradeHref} className={buttonVariants({ variant: "secondary", size: "sm" })}>
          See plans
        </Link>
      ) : null}
    </div>
  );
}
