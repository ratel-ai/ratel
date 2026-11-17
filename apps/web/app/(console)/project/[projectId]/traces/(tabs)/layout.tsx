import type { ReactNode } from "react";
import { TracesFrame } from "@/components/console/traces-sessions/TracesFrame";
import { tracesSessionsEnabled } from "@/lib/synthesis/traces-sessions-flag";

/**
 * RC-312, RC-331: the Sessions tab and each tab's own summary. Owned (ADR-0030): behind the
 * deployment switch `FF_TRACES_SESSIONS` in place of upstream's `cloud-traces-sessions`.
 */
export default async function TracesLayout({ children }: { children: ReactNode }) {
  const enabled = tracesSessionsEnabled();
  return <TracesFrame enabled={enabled}>{children}</TracesFrame>;
}
