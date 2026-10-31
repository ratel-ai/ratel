"use client";

import { cn } from "@ratel/design-system/cn";
import { Skeleton } from "@ratel/design-system/states";
import { Tooltip } from "@ratel/design-system/tooltip";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AskIcon, ExampleSourceIcon } from "@/components/console/intents/marks";
import { captureClientException } from "@/lib/platform/track-client";
import type { ExampleAsk, ExampleTarget } from "@/lib/views/intents/topics-examples";

export type ExamplesLoad = (
  target: ExampleTarget,
) => Promise<{ ok: true; examples: ExampleAsk[] } | { ok: false; message: string }>;

type State =
  | { status: "loading" }
  | { status: "ready"; examples: ExampleAsk[] }
  | { status: "error"; message: string };

/**
 * Example asks, read when the panel opens (captured content stays out of the
 * page until someone asks to see it). Each is a quote marked by its source
 * (the person's words, or the agent's search standing in for them), with its
 * run one click away in Traces. Text only, never an attribute.
 */
export function TopicExamples({
  target,
  load,
  title = "Example asks",
}: {
  target: ExampleTarget;
  load: ExamplesLoad;
  title?: string;
}) {
  const pathname = usePathname();
  const [state, setState] = useState<State>({ status: "loading" });
  const pathRef = useRef(pathname);
  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);
  // Read once per target. The loader is a server action bound on the page, and
  // every server action on a project page ends in a refresh that hands over a
  // new copy of it; following its identity would read again forever.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  const key = JSON.stringify(target);
  useEffect(() => {
    let cancelled = false;
    loadRef.current(JSON.parse(key) as ExampleTarget).then(
      (result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? { status: "ready", examples: result.examples }
            : { status: "error", message: result.message },
        );
      },
      (error: unknown) => {
        // Reported, never dropped: a failed read is a bug or an outage worth seeing.
        captureClientException(error, {
          digest: null,
          pathname: pathRef.current ?? "",
          boundary: "app",
        });
        if (!cancelled)
          setState({
            status: "error",
            message: "Couldn't load the example asks. Try again in a moment.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);

  return (
    <section aria-busy={state.status === "loading"} className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
        <AskIcon />
        {title}
      </h3>
      {state.status === "loading" ? (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className={cn("h-9", index === 1 ? "w-2/3" : "w-4/5")} />
          ))}
        </div>
      ) : state.status === "error" ? (
        <p className="text-ui text-fg-muted">{state.message}</p>
      ) : state.examples.length === 0 ? (
        <p className="text-ui text-fg-muted">
          No captured asks to show. They appear when your agent sends people&apos;s messages.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {state.examples.map((example) => (
            <li
              key={example.id}
              className="flex items-start gap-2 rounded-md bg-raised py-2 pr-1 pl-3"
            >
              <span className="mt-0.5 flex shrink-0">
                <ExampleSourceIcon source={example.source} />
              </span>
              <p className="min-w-0 flex-1 text-ui break-words text-fg">“{example.text}”</p>
              <Tooltip content="Open the run in Traces">
                <Link
                  href={example.href}
                  aria-label="Open the run in Traces"
                  className="-my-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle outline-none transition-colors duration-120 hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <ArrowUpRight aria-hidden className="size-3.5" />
                </Link>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
