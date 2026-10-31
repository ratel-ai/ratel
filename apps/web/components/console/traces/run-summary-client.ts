"use client";

import type { RunSummaryResult } from "@/lib/synthesis/traces/v2/run-summary-route";

const FAILED: RunSummaryResult = {
  ok: false,
  message: "Couldn't load this run. Try again in a moment.",
};

/**
 * The run Panel's loader: the summary route, read as JSON. Network failures
 * read as a retryable error; an aborted read (the Panel moved on) resolves the
 * same way and its caller drops it.
 */
export async function fetchRunSummary(
  projectId: string,
  traceId: string,
  signal?: AbortSignal,
): Promise<RunSummaryResult> {
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}/summary`,
      { headers: { accept: "application/json" }, cache: "no-store", signal },
    );
    const body: unknown = await response.json().catch(() => null);
    return isResult(body) ? body : FAILED;
  } catch {
    return FAILED;
  }
}

function isResult(value: unknown): value is RunSummaryResult {
  if (!value || typeof value !== "object" || !("ok" in value)) return false;
  const result = value as { ok: unknown; message?: unknown; summary?: unknown };
  return result.ok === true
    ? typeof result.summary === "object"
    : typeof result.message === "string";
}
