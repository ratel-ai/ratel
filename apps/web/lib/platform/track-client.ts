import { clientAnalytics } from "@/lib/contracts/client-analytics";

/**
 * The client-side analytics shim: upstream's `track` and `captureClientException` names over the
 * browser seam (`lib/contracts/client-analytics.ts`). The open-source edition installs nothing, so
 * both return without sending anything; an edition that installs its client receives every call.
 * Like upstream's, neither ever throws into the component.
 */

export type ClientEventName = string;
export type ClientEventProperties = Record<string, unknown>;

/** The error boundary that caught an exception, as upstream reports it. */
export type ClientExceptionProperties = {
  digest: string | null;
  pathname: string;
  boundary: "app" | "global";
};

export function track(event: ClientEventName, properties?: ClientEventProperties): void {
  safely(`capture ${event}`, (analytics) => analytics.track(event, properties));
}

export function captureClientException(error: unknown, properties?: Record<string, unknown>): void {
  safely("capture client exception", (analytics) => analytics.captureException(error, properties));
}

function safely(
  operation: string,
  run: (analytics: NonNullable<ReturnType<typeof clientAnalytics>>) => void,
): void {
  const analytics = clientAnalytics();
  if (!analytics) return;
  try {
    run(analytics);
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: upstream's browser-side report; no logger runs here
    console.error(`[analytics] failed to ${operation}:`, error);
  }
}
