import { type ParamDraft, type ParamSpec, paramsOfDraft } from "@/lib/views/sandboxes/run-form";
import { type DatasetDraft, draftQuery } from "./dataset-pages";
import type { DatasetQuery } from "./domain/dataset";
import { combinationCount, MAX_COMBINATIONS, MAX_EVAL_TRIALS } from "./domain/eval";
import type { LibraryEntry } from "./scorer-library";

/**
 * The rules of the "New eval" dialog: what it sends, or why it cannot send yet. The server checks
 * each rule again (`eval-dialog-api.ts`).
 */

/** "Production agent" is a runtime that comes later: the dialog shows it, and no one can pick it. */
export const PRODUCTION_AGENT = { label: "Production agent", note: "Coming soon" } as const;
export const LATEST = "latest";

export type ScorerChoice = {
  source: "project" | "predefined";
  /** The project scorer id, or the pre-defined key. */
  id: string;
  name: string;
  /** The settings of a pre-defined scorer, with the values as typed. */
  settings: Array<{ name: string; type: "string" | "number"; value: string }>;
};

export type EvalDraft = {
  name: string;
  taskId: string;
  sandboxName: string;
  /** `LATEST`: the newest ready version when a run starts. Else a pinned version id. */
  versionId: string;
  dataset: { mode: "existing"; datasetId: string } | { mode: "query"; draft: DatasetDraft };
  params: ParamDraft;
  /** The values of the matrix of each param, as typed ("small, large"). Used when `matrixOn`. */
  matrix: Record<string, string>;
  matrixOn: boolean;
  trials: string;
  scorers: ScorerChoice[];
};

export type EvalRequest = {
  name: string;
  taskId: string | null;
  runtime: { sandboxName: string; sandboxVersionId: string | null };
  dataset: { datasetId: string } | { query: DatasetQuery };
  params: Record<string, string | number | boolean>;
  matrix: Record<string, Array<string | number | boolean>>;
  trials: number;
  scorers: Array<{
    id: string;
    name: string;
    gating: true;
    ref:
      | { source: "project"; scorerId: string }
      | { source: "predefined"; key: string; settings: Record<string, string | number> };
  }>;
};

export type MatrixResult =
  | { ok: true; matrix: EvalRequest["matrix"]; count: number }
  | { ok: false; message: string; count: number };

/**
 * The matrix of the params that have values: each value typed as the param declares it. More
 * than `MAX_COMBINATIONS` combinations is refused, with the count.
 */
export function matrixOf(
  params: readonly ParamSpec[],
  texts: Record<string, string>,
): MatrixResult {
  const matrix: EvalRequest["matrix"] = {};
  for (const param of params) {
    const parts = (texts[param.name] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;
    const values: Array<string | number | boolean> = [];
    for (const part of new Set(parts)) {
      const typed = typedValue(param, part);
      if (!typed.ok) return { ok: false, message: typed.message, count: 0 };
      values.push(typed.value);
    }
    matrix[param.name] = values;
  }
  const count = combinationCount(matrix);
  if (count > MAX_COMBINATIONS) {
    return {
      ok: false,
      count,
      message: `A matrix has at most ${MAX_COMBINATIONS} combinations, and this one has ${count}. Each combination is a variant of every run. Take out some values.`,
    };
  }
  return { ok: true, matrix, count };
}

/** The request of the dialog, or the first reason it cannot be sent. */
export function evalRequestOf(
  draft: EvalDraft,
  params: readonly ParamSpec[],
): { ok: true; request: EvalRequest } | { ok: false; message: string } {
  const name = draft.name.trim();
  if (!name) return { ok: false, message: "Give the eval a name." };
  if (!draft.sandboxName) return { ok: false, message: "Choose the runtime: a sandbox." };
  let dataset: EvalRequest["dataset"];
  if (draft.dataset.mode === "existing") {
    if (!draft.dataset.datasetId) return { ok: false, message: "Choose a dataset." };
    dataset = { datasetId: draft.dataset.datasetId };
  } else {
    const query = draftQuery(draft.dataset.draft);
    if (!query.ok) return query;
    dataset = { query: query.query };
  }
  const defaults = paramsOfDraft(params, draft.params);
  if (!defaults.ok) return { ok: false, message: Object.values(defaults.errors)[0] ?? "" };
  const matrix = draft.matrixOn ? matrixOf(params, draft.matrix) : null;
  if (matrix && !matrix.ok) return matrix;
  const trials = Number(draft.trials.trim());
  if (!Number.isInteger(trials) || trials < 1 || trials > MAX_EVAL_TRIALS) {
    return { ok: false, message: `Give a number of trials from 1 to ${MAX_EVAL_TRIALS}.` };
  }
  if (draft.scorers.length === 0) return { ok: false, message: "Choose at least one scorer." };
  const scorers: EvalRequest["scorers"] = [];
  for (const choice of draft.scorers) {
    const made = scorerOf(choice);
    if (!made.ok) return made;
    scorers.push(made.scorer);
  }
  // A param in the matrix takes its values from it, not a default.
  const varied = new Set(Object.keys(matrix?.ok ? matrix.matrix : {}));
  return {
    ok: true,
    request: {
      name,
      taskId: draft.taskId.trim() || null,
      runtime: {
        sandboxName: draft.sandboxName,
        sandboxVersionId: draft.versionId === LATEST ? null : draft.versionId,
      },
      dataset,
      params: Object.fromEntries(
        Object.entries(defaults.value).filter(([param]) => !varied.has(param)),
      ),
      matrix: matrix?.ok ? matrix.matrix : {},
      trials,
      scorers,
    },
  };
}

/** The library entries that the dialog offers, by group: the project's, then the pre-defined. */
export function scorerGroups(entries: readonly LibraryEntry[]): {
  project: LibraryEntry[];
  predefined: LibraryEntry[];
} {
  return {
    project: entries.filter(({ source }) => source === "project"),
    predefined: entries.filter(({ source }) => source === "predefined"),
  };
}

/** The entries whose name or description has the text, in any case. */
export function searchScorers(entries: readonly LibraryEntry[], text: string): LibraryEntry[] {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return [...entries];
  return entries.filter((entry) =>
    `${entry.name} ${entry.description ?? ""}`.toLowerCase().includes(wanted),
  );
}

function scorerOf(
  choice: ScorerChoice,
): { ok: true; scorer: EvalRequest["scorers"][number] } | { ok: false; message: string } {
  const id = `${choice.source}-${choice.id}`.slice(0, 100);
  if (choice.source === "project") {
    return {
      ok: true,
      scorer: {
        id,
        name: choice.name,
        gating: true,
        ref: { source: "project", scorerId: choice.id },
      },
    };
  }
  const settings: Record<string, string | number> = {};
  for (const { name, type, value } of choice.settings) {
    const text = value.trim();
    if (!text) return { ok: false, message: `"${choice.name}" needs its ${name}.` };
    const number = Number(text);
    if (type === "number" && !Number.isFinite(number)) {
      return { ok: false, message: `The ${name} of "${choice.name}" is a number.` };
    }
    settings[name] = type === "number" ? number : text;
  }
  return {
    ok: true,
    scorer: {
      id,
      name: choice.name,
      gating: true,
      ref: { source: "predefined", key: choice.id, settings },
    },
  };
}

function typedValue(
  param: ParamSpec,
  text: string,
): { ok: true; value: string | number | boolean } | { ok: false; message: string } {
  if (param.type === "boolean") {
    if (text === "true" || text === "false") return { ok: true, value: text === "true" };
    return { ok: false, message: `${param.name} takes true or false.` };
  }
  const typed = paramsOfDraft([param], { [param.name]: text });
  if (!typed.ok) return { ok: false, message: Object.values(typed.errors)[0] ?? "" };
  const value = typed.value[param.name];
  return value === undefined
    ? { ok: false, message: `Give ${param.name} a value.` }
    : { ok: true, value };
}
