import type { CheckOp, Scorer, ScorerKind } from "./domain/types";

/**
 * RC-615: a scorer's config as the detail page's form holds it (text fields),
 * and back. Pure. The domain validates the config on save; this only reads text.
 */

export interface ScorerForm {
  name: string;
  enabled: boolean;
  /** 0..100, as the form shows it. */
  threshold: string;
  path: string;
  op: CheckOp;
  value: string;
  logic: string;
  criteria: string;
  question: string;
  /** One option a line: `id: label`. */
  options: string;
  /** Passing option ids, comma separated. */
  pass: string;
}

export function formOf(scorer: Scorer): ScorerForm {
  const base: ScorerForm = {
    name: scorer.name,
    enabled: scorer.enabled,
    threshold: String(Math.round(scorer.goodThreshold * 100)),
    path: "",
    op: "lte",
    value: "",
    logic: "",
    criteria: "",
    question: "",
    options: "",
    pass: "",
  };
  switch (scorer.kind) {
    case "check":
      return {
        ...base,
        path: scorer.config.path,
        op: scorer.config.op,
        value: scorer.config.value === undefined ? "" : valueText(scorer.config.value),
      };
    case "expression":
      return { ...base, logic: JSON.stringify(scorer.config.logic, null, 2) };
    case "judge":
      return { ...base, criteria: scorer.config.criteria };
    case "decision":
      return {
        ...base,
        question: scorer.config.question,
        options: scorer.config.options.map((option) => `${option.id}: ${option.label}`).join("\n"),
        pass: scorer.config.pass.join(", "),
      };
  }
}

/** The form's config for a kind, or an error the form shows. */
export function configOf(
  kind: ScorerKind,
  form: ScorerForm,
): { ok: true; config: unknown } | { ok: false; error: string } {
  switch (kind) {
    case "check":
      return {
        ok: true,
        config: {
          path: form.path.trim(),
          op: form.op,
          ...(form.op === "exists" || form.op === "not_exists"
            ? {}
            : { value: valueOf(form.value) }),
        },
      };
    case "expression":
      try {
        return { ok: true, config: { logic: JSON.parse(form.logic) } };
      } catch {
        return { ok: false, error: "The rule is not valid JSON." };
      }
    case "judge":
      return { ok: true, config: { criteria: form.criteria } };
    case "decision": {
      const options = form.options
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf(":");
          return at === -1
            ? { id: line, label: line }
            : { id: line.slice(0, at).trim(), label: line.slice(at + 1).trim() };
        });
      const pass = form.pass
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      return { ok: true, config: { question: form.question, options, pass } };
    }
  }
}

/** The threshold the form holds, as 0..1; null when it is not a number from 0 to 100. */
export function thresholdOf(form: ScorerForm): number | null {
  const value = Number(form.threshold);
  return form.threshold.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value / 100
    : null;
}

/** A check value as typed: a number, true, false or null when it reads as one, JSON when it is JSON, else the text. */
function valueOf(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed !== "" && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  if (
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "null" ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not JSON after all: the text is the value.
      return text;
    }
  }
  return text;
}

function valueText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
