"use client";

import { DotLoaderLazy } from "@ratel/design-system/dot-loader-lazy";
import { Tooltip } from "@ratel/design-system/tooltip";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import {
  IDLE_POLL_MS,
  minutesAgo,
  pendingPollMs,
  type SectionProgress,
  shouldRefresh,
} from "@/lib/views/freshness/model";
import type { AnalysisSection } from "@/lib/views/freshness/sections";

const noSubscription = () => () => {};

/**
 * One page's analysis status, for the right side of its header (RC-210).
 * While the jobs behind the page are queued or running it says "Updating"
 * with the dot loader; when they finish, the page reads itself again, so
 * new results appear without a reload. Idle, it shows `children` (the page's
 * own "read 3 min ago"), or nothing. Polls only while the tab is visible.
 */
export function AnalysisStatus({
  projectId,
  section,
  initial = null,
  children,
}: {
  projectId: string;
  section: AnalysisSection;
  /** The server's read, so the first paint is already right; null fetches on mount. */
  initial?: SectionProgress | null;
  children?: ReactNode;
}) {
  const [progress, setProgress] = useState<SectionProgress | null>(initial);
  const [now, setNow] = useState(() => Date.now());
  // The poller needs the app router, which only exists in the browser.
  const inBrowser = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const poller = inBrowser ? (
    <StatusPoller
      projectId={projectId}
      section={section}
      initial={initial}
      onProgress={(next) => {
        setProgress(next);
        setNow(Date.now());
      }}
    />
  ) : null;

  if (!progress || progress.pending === 0) {
    return (
      <>
        {poller}
        {children}
      </>
    );
  }
  const since = progress.lastDoneAt ? `Last updated ${minutesAgo(progress.lastDoneAt, now)}. ` : "";
  return (
    <>
      {poller}
      <Tooltip content={`${since}This page refreshes on its own when it finishes.`}>
        <span
          role="status"
          data-analysis-status="updating"
          className="inline-flex items-center gap-2 text-xs text-fg-subtle"
        >
          <DotLoaderLazy label="Updating" size="sm" tone="neutral" />
          Updating with new runs
        </span>
      </Tooltip>
    </>
  );
}

/**
 * Asks the server where the page's jobs stand: backing off while they run,
 * once a minute while idle, and only while the tab is visible. Reads the
 * page again when its work finishes or a newer result lands.
 */
function StatusPoller({
  projectId,
  section,
  initial,
  onProgress,
}: {
  projectId: string;
  section: AnalysisSection;
  initial: SectionProgress | null;
  onProgress: (progress: SectionProgress) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const last = useRef<SectionProgress | null>(initial);
  const report = useRef(onProgress);
  useEffect(() => {
    report.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let tick = 0;
    const load = async () => {
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(`/api/projects/${projectId}/freshness?section=${section}`, {
            cache: "no-store",
          });
          if (response.status === 200 && !cancelled) {
            const next = (await response.json()) as SectionProgress;
            if (shouldRefresh(last.current, next)) startTransition(() => router.refresh());
            last.current = next;
            report.current(next);
          }
        } catch {
          // Offline or a slow read: keep what the header already shows.
        }
      }
      if (cancelled) return;
      const pending = (last.current?.pending ?? 0) > 0;
      tick = pending ? tick + 1 : 0;
      timer = window.setTimeout(load, pending ? pendingPollMs(tick) : IDLE_POLL_MS);
    };
    const first = last.current;
    if (first) {
      timer = window.setTimeout(load, first.pending > 0 ? pendingPollMs(0) : IDLE_POLL_MS);
    } else {
      void load();
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [projectId, section, router]);

  return null;
}
