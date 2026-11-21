"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Skeleton } from "@ratel/design-system/states";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatRelativeTime, formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import type { ExampleView } from "@/lib/views/health/self-corrections/page-model";

/**
 * Recent self-corrections, each a card: what kind, what came before it, and
 * for a phrase the agent's own words around it with the phrase marked. The
 * words are read on demand from content capture (one request per card, when
 * it mounts), never rendered by the server and never put in an attribute.
 * Without a reply to show, one sentence says what happened.
 */

type ReplyState =
  | { state: "loading" }
  | { state: "read"; before: string; phrase: string; after: string }
  | { state: "expired" }
  | { state: "no_text" }
  | { state: "error" };

function exampleUrl(projectId: string, id: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/self-corrections/${encodeURIComponent(id)}/example`;
}

function useReply(projectId: string, example: ExampleView): [ReplyState, () => void] {
  const [reply, setReply] = useState<ReplyState>(
    example.hasText ? { state: "loading" } : { state: "no_text" },
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!example.hasText) return;
    const controller = new AbortController();
    fetch(exampleUrl(projectId, example.id), { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { ok: boolean; example?: ReplyState };
        setReply(response.ok && body.ok && body.example ? body.example : { state: "error" });
      })
      .catch((error: unknown) => {
        if ((error as { name?: string })?.name !== "AbortError") setReply({ state: "error" });
      });
    return () => controller.abort();
  }, [projectId, example.id, example.hasText, attempt]);
  const retry = () => {
    setReply({ state: "loading" });
    setAttempt((n) => n + 1);
  };
  return [reply, retry];
}

function Words({
  reply,
  example,
  retry,
}: {
  reply: ReplyState;
  example: ExampleView;
  retry: () => void;
}) {
  switch (reply.state) {
    case "loading":
      return (
        <div aria-hidden className="flex flex-col gap-2 py-1">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      );
    case "read":
      return (
        <p className="text-sm text-fg">
          “{reply.before}
          <mark className="rounded-sm bg-accent-subtle px-0.5 text-fg">{reply.phrase}</mark>
          {reply.after}”
        </p>
      );
    case "expired":
      return (
        <p className="text-sm text-fg-muted">{example.summary} The reply is no longer kept.</p>
      );
    case "error":
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <span>Couldn&apos;t load what the agent said.</span>
          <Button size="sm" variant="ghost" onClick={retry}>
            Try again
          </Button>
        </div>
      );
    case "no_text":
      return <p className="text-sm text-fg">{example.summary}</p>;
  }
}

function ExampleCard({
  projectId,
  example,
  now,
}: {
  projectId: string;
  example: ExampleView;
  now: string;
}) {
  const [reply, retry] = useReply(projectId, example);
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-line bg-raised p-4">
      <p className="text-xs text-fg-subtle">
        <span className="font-medium text-fg-muted">{example.kindLabel}</span> · {example.context}
      </p>
      <div aria-live="polite" className="min-h-10 flex-1">
        <Words reply={reply} example={example} retry={retry} />
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-fg-subtle">
        <time
          dateTime={example.occurredAt}
          title={formatTimestamp(example.occurredAt)}
          className="tabular-nums"
        >
          {formatRelativeTime(example.occurredAt, now)}
        </time>
        <Link
          href={example.traceHref}
          className="inline-flex items-center gap-1 rounded-sm font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          Open trace
          <ArrowUpRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </li>
  );
}

/** The cards, two across; the heading is the caller's. */
export function Examples({
  projectId,
  examples,
  now,
  className,
}: {
  projectId: string;
  examples: readonly ExampleView[];
  now: string;
  className?: string;
}) {
  if (examples.length === 0)
    return (
      <p className={cn("py-1 text-ui text-fg-subtle", className)}>No examples in this window.</p>
    );
  return (
    <ul
      className={cn("grid grid-cols-1 gap-3 md:grid-cols-2", className)}
      data-corrections-examples={examples.length}
    >
      {examples.map((example) => (
        <ExampleCard key={example.id} projectId={projectId} example={example} now={now} />
      ))}
    </ul>
  );
}
