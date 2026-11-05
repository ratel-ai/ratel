import { fixHref, issueHref, taskHref, topicHref } from "@/lib/views/fixes/href";
import type { Fix } from "@/lib/views/fixes/types";
import { KIND_NOUNS, type LineageRef } from "./types";

/**
 * Pure, client-safe half of the lineage module: where a ref opens, the refs
 * for the objects the console already has in hand, and the source a loaded
 * Fix names. Pages use these to link one step back without another read;
 * `resolve.ts` (server) answers for an object only known by its id.
 */

const enc = encodeURIComponent;

function root(projectId: string): string {
  return `/project/${enc(projectId)}`;
}

/**
 * The page a ref opens, or null for a kind the console has no page for. A ref
 * that carries its own `href` keeps it: the producer knows best (RC-46's evals).
 */
export function hrefFor(ref: LineageRef, projectId: string): string | null {
  if (ref.href) return ref.href;
  switch (ref.kind) {
    case "trace":
      return `${root(projectId)}/traces/${enc(ref.id)}`;
    case "metric":
      // A reading lives on Monitor's home, beside the run counts.
      return root(projectId);
    case "insight":
      return issueHref(projectId, ref.id);
    case "intent":
      return topicHref(projectId, ref.id);
    case "task":
      return taskHref(projectId, ref.id);
    case "fix":
      return fixHref(projectId, { peek: ref.id });
    case "experiment":
      // `~` keeps "." and ".." names off URL dot-segments (lib/traces/experiment-view.ts).
      return `${root(projectId)}/calibration/~${enc(ref.id)}`;
    case "eval":
      // An eval carries its own href (`evalRef`): its id is the eval set's, which
      // does not name the fix. Without one, the Fixes page is the closest.
      return fixHref(projectId);
    case "shipment":
      return `${shipRoot(projectId)}?peek=${enc(ref.id)}`;
    default:
      return null;
  }
}

/** RC-46's eval page for a fix: its eval set, the runs it simulates and the before → after. */
export function evalPageHref(projectId: string, fixId: string): string {
  return `${root(projectId)}/improvement/fixes/${enc(fixId)}/eval`;
}

/** Ship, the fourth stage's page. */
export function shipRoot(projectId: string): string {
  return `${root(projectId)}/ship`;
}

/** The same ref with its `href` filled in, when it has one. */
export function withHref(ref: LineageRef, projectId: string): LineageRef {
  const href = hrefFor(ref, projectId);
  return href ? { ...ref, href } : ref;
}

/* - Refs for objects in hand ------------------------------------------------- */

export function traceRef(traceId: string, label?: string): LineageRef {
  return { stage: "monitor", kind: "trace", id: traceId, ...(label ? { label } : {}) };
}

export function metricRef(metric: string, label?: string): LineageRef {
  return { stage: "monitor", kind: "metric", id: metric, ...(label ? { label } : {}) };
}

export function insightRef(signalId: string, label?: string): LineageRef {
  return { stage: "insights", kind: "insight", id: signalId, ...(label ? { label } : {}) };
}

export function fixRef(fixId: string, label?: string): LineageRef {
  return { stage: "improve", kind: "fix", id: fixId, ...(label ? { label } : {}) };
}

export function experimentRef(name: string): LineageRef {
  return { stage: "improve", kind: "experiment", id: name, label: name };
}

/**
 * An eval of a fix (RC-46), by its eval set id (one set per fix), opening on
 * the fix's eval page. Its source is the fix.
 */
export function evalRef(
  projectId: string,
  evalId: string,
  fixId: string,
  label?: string,
): LineageRef {
  return {
    stage: "improve",
    kind: "eval",
    id: evalId,
    ...(label ? { label } : {}),
    href: evalPageHref(projectId, fixId),
  };
}

export function shipmentRef(shipmentId: string, label?: string): LineageRef {
  return { stage: "ship", kind: "shipment", id: shipmentId, ...(label ? { label } : {}) };
}

/** An applied description rewrite is a shipment: Cloud made the change itself. */
export function appliedRewriteShipmentId(proposalId: string): string {
  return `rewrite:${proposalId}`;
}

/**
 * The insight a loaded Fix came from, one step back: the worst issue it
 * resolves (Fixes already sorts them), else the intent it was found in, else
 * the busiest task it helps. Null when it names none (a rewrite drafted from
 * missed searches alone).
 */
export function fixSourceRef(
  projectId: string,
  fix: Pick<Fix, "issues" | "intent" | "subject">,
): LineageRef | null {
  const issue = fix.issues[0];
  if (issue)
    return {
      stage: "insights",
      kind: "insight",
      id: issue.id,
      label: issue.title,
      href: issue.href,
    };
  if (fix.intent)
    return {
      stage: "insights",
      kind: "intent",
      id: fix.intent.id,
      label: fix.intent.label,
      href: fix.intent.href,
    };
  const task = fix.subject.tasks[0];
  if (task)
    return { stage: "insights", kind: "task", id: task.id, label: task.label, href: task.href };
  return null;
}

/** The fix an applied-rewrite shipment came from (`rewrite:<id>` on both sides). */
export function shipmentSourceRef(shipmentId: string, fixLabel?: string): LineageRef | null {
  return shipmentId.startsWith("rewrite:") ? fixRef(shipmentId, fixLabel) : null;
}

/**
 * An id as the reader sees it: whole when short, else its head and tail
 * ("4f2a91…c07e"), per DESIGN.md's identifiers. Labels are never cut.
 */
export function shortId(id: string, max = 14): string {
  if (id.length <= max) return id;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${id.slice(0, head)}…${id.slice(id.length - tail)}`;
}

/** "trace 4f2a91…c07e", "insight Wrong tool keeps showing up": the words after "From". */
export function refPhrase(ref: LineageRef): string {
  const noun = KIND_NOUNS[ref.kind] ?? ref.kind;
  return ref.label ? `${noun} ${ref.label}` : `${noun} ${shortId(ref.id)}`;
}
