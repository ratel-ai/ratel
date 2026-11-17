import { cn } from "@ratel/design-system/cn";
import { MessagesSquare } from "lucide-react";
import Link from "next/link";
import type { TraceSession } from "@/lib/views/session-chat/trace-session";

/**
 * On a turn's trace page (RC-472): the session it is
 * part of, as a link to the session's chat, and the session's turns on top,
 * each opening its own trace. A turn with no trace shows dashed and opens the
 * session's Trace view at that turn instead.
 */
export function TraceSessionBar({
  projectId,
  session,
}: {
  projectId: string;
  session: TraceSession;
}) {
  const project = `/project/${encodeURIComponent(projectId)}`;
  const sessionHref = `${project}/sessions/${encodeURIComponent(session.sessionId)}`;
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      data-trace-session={session.sessionId}
    >
      <Link
        href={sessionHref}
        className="flex min-w-0 items-center gap-1.5 text-ui text-fg-muted hover:text-fg"
        data-part-of-session
      >
        <MessagesSquare className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0">Part of session ·</span>
        <span className="truncate text-fg">{session.title}</span>
      </Link>
      {session.turns.length > 1 ? (
        <nav
          aria-label="Turns of this session"
          className="flex flex-wrap items-center gap-1.5"
          data-turn-picker
        >
          <span className="mr-1 text-ui text-fg-muted">Turn</span>
          {session.turns.map((turn) => (
            <Link
              key={turn.turnIndex}
              href={
                turn.traceId
                  ? `${project}/traces/${encodeURIComponent(turn.traceId)}`
                  : `${sessionHref}?view=trace&turn=${turn.turnIndex}`
              }
              aria-current={turn.turnIndex === session.turnIndex ? "page" : undefined}
              title={turn.ask ?? undefined}
              data-turn={turn.turnIndex}
              className={cn(
                "min-w-8 rounded-md border px-2 py-0.5 text-center text-ui tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus",
                turn.turnIndex === session.turnIndex
                  ? "border-line-active bg-raised font-medium text-fg"
                  : "border-line text-fg-muted hover:bg-hover",
                turn.traceId === null && "border-dashed",
              )}
            >
              {turn.turnIndex}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
