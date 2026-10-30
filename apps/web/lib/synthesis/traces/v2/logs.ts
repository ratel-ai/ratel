/**
 * SDK logs and experiment records in plain words (DESIGN.md, Glossary): an arm
 * is a "Variant", shadow ranking is a "comparison", and snake_case event names
 * stay behind the Panel's details.
 */

export type LogTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface LogPresentation {
  label: string;
  description: string;
  tone: LogTone;
}

const PRESENTATIONS: Readonly<Record<string, LogPresentation>> = {
  "ratel.experiment.results": {
    label: "Results",
    description: "A variant recorded its results",
    tone: "success",
  },
  "ratel.experiment.comparison": {
    label: "Comparison",
    description: "The current and comparison variants were compared",
    tone: "info",
  },
  "ratel.experiment.skip": {
    label: "Skipped",
    description: "A variant was not evaluated",
    tone: "neutral",
  },
  "ratel.experiment.fallback": {
    label: "Fallback",
    description: "Serving moved to another variant",
    tone: "warning",
  },
  "ratel.experiment.drop": {
    label: "Dropped",
    description: "A variant's result was left out",
    tone: "danger",
  },
  "ratel.experiment.outcome": {
    label: "Outcome",
    description: "A delayed outcome arrived",
    tone: "neutral",
  },
};

export function logPresentation(eventName: string): LogPresentation {
  return (
    PRESENTATIONS[eventName] ?? {
      label: humanEventName(eventName),
      description: "SDK log",
      tone: "neutral",
    }
  );
}

/** "ratel.catalog.definition" reads as "Catalog definition". */
export function humanEventName(eventName: string): string {
  const words = eventName
    .replace(/^ratel\.(?:experiment\.)?/, "")
    .split(/[._\s]+/)
    .filter(Boolean)
    .join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : eventName;
}

/** "ranking-v2 · candidate", the experiment and its variant, when present. */
export function experimentLabel(event: {
  experimentName: string | null;
  experimentArm: string | null;
}): string | null {
  const parts = [event.experimentName, event.experimentArm].filter((part): part is string =>
    Boolean(part?.trim()),
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

const ATTRIBUTE_LABELS: Readonly<Record<string, string>> = {
  "ratel.experiment.result_count": "Results",
  "ratel.experiment.result_ids": "Result ids",
  "ratel.experiment.agreement.top1": "Same first pick",
  "ratel.experiment.agreement.exact_order": "Same order",
  "ratel.experiment.agreement.jaccard_at_k": "Agreement",
  "ratel.experiment.agreement.k": "Compared top",
  "ratel.experiment.skip.reason": "Reason",
  "ratel.experiment.fallback.effective_arm": "Used variant",
  "ratel.experiment.fallback.reason": "Reason",
  "ratel.experiment.drop.reason": "Reason",
};

/** A record attribute in words: known keys get a name, the rest lose their prefix. */
export function attributeLabel(key: string): string {
  return ATTRIBUTE_LABELS[key] ?? humanEventName(key);
}

/** Booleans from comparisons read as words, numbers keep three decimals at most. */
export function attributeValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Identity keys every record repeats; the row already shows them. */
const IDENTITY_KEYS = new Set([
  "ratel.experiment.id",
  "ratel.experiment.arm",
  "ratel.experiment.role",
  "ratel.experiment.selection_id",
  "ratel.experiment.result_attrs",
]);

/** The few attributes worth a glance, known ones first. */
export function salientAttributes(
  attributes: Readonly<Record<string, unknown>>,
  limit = 4,
): { key: string; label: string; value: string }[] {
  const known = Object.keys(ATTRIBUTE_LABELS);
  return Object.entries(attributes)
    .filter(([key, value]) => !IDENTITY_KEYS.has(key) && value !== null && value !== "")
    .sort(
      ([left], [right]) =>
        rank(left, known) - rank(right, known) || (left < right ? -1 : left > right ? 1 : 0),
    )
    .slice(0, limit)
    .map(([key, value]) => ({ key, label: attributeLabel(key), value: attributeValue(value) }));
}

function rank(key: string, known: readonly string[]): number {
  const index = known.indexOf(key);
  return index === -1 ? known.length : index;
}
