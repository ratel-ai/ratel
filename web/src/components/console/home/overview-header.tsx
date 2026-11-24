import { StatusDot } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Callout } from "@ratel/design-system/states";
import Link from "next/link";
import { formatTimestamp } from "@/lib/synthesis/traces/format";
import { OVERVIEW_WINDOWS, overviewRangeParam } from "@/lib/views/home/overview-model";
import { relativeTimeLabel } from "@/lib/views/intents/adaptive-view";

/** Fresh enough to call the connection live. */
const LIVE_MS = 24 * 60 * 60 * 1_000;

export function TelemetryStatus({ lastEventAt, now }: { lastEventAt: Date | null; now: Date }) {
  if (!lastEventAt) return <StatusDot tone="neutral" label="No data yet" />;
  const live = now.getTime() - lastEventAt.getTime() < LIVE_MS;
  return (
    <span title={`Last event ${formatTimestamp(lastEventAt)}`}>
      <StatusDot
        tone={live ? "success" : "neutral"}
        label={live ? "Receiving data" : `Last event ${relativeTimeLabel(lastEventAt, now)}`}
      />
    </span>
  );
}

/** The window as links, so it lives in the URL and survives a reload. */
export function WindowSwitch({ root, window }: { root: string; window: number }) {
  return (
    <nav
      aria-label="Time window"
      className="inline-flex items-center gap-0.5 rounded-md border border-line bg-app p-0.5"
    >
      {OVERVIEW_WINDOWS.map((option) => {
        const active = option === window;
        return (
          <Link
            key={option}
            href={option === 7 ? root : `${root}?range=${overviewRangeParam(option)}`}
            aria-current={active ? "true" : undefined}
            className={cn(
              "inline-flex h-6 items-center rounded-[4px] px-2 text-ui font-medium outline-none transition-colors duration-120 focus-visible:ring-2 focus-visible:ring-focus",
              active ? "bg-selected text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {option} days
          </Link>
        );
      })}
    </nav>
  );
}

export function DemoNotice({ projectId, projectName }: { projectId: string; projectName: string }) {
  return (
    <div data-tour="demo-notice">
      <Callout
        title={`${projectName} is sample data`}
        action={
          <Link href="/onboarding" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Create your own project
          </Link>
        }
      >
        Every run, cost and fix here is made up.{" "}
        <Link
          href={`/project/${encodeURIComponent(projectId)}/settings/danger`}
          className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-muted"
        >
          Delete it
        </Link>{" "}
        when you are done.
      </Callout>
    </div>
  );
}
