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

/** The defaults of an eval, as "New run" starts from them. */
export type RunDefaults = {
  datasetId: string;
  /** `LATEST`, or the pinned version of the eval. */
  versionId: string;
  params: Record<string, unknown>;
  matrix: Record<string, unknown[]>;
  trials: number;
};

export type RunDraft = {
  name: string;
  datasetId: string;
  addRows:
    | { mode: "none" }
    | { mode: "traces"; turnIds: string[] }
    | { mode: "last" | "auto"; limit: string };
  /** Other scorers for this run only. Null: the scorers of the eval. */
  scorers: ScorerChoice[] | null;
  versionId: string;
  params: ParamDraft;
  matrix: Record<string, string>;
  matrixOn: boolean;
  trials: string;
};

export type RunRequest = {
  name?: string;
  datasetId?: string;
  addRows?: { turnIds: string[] } | { query: { kind: "last_traces" | "auto"; limit: number } };
  scorers?: EvalRequest["scorers"];
  sandboxVersion?: string;
  params?: Record<string, string | number | boolean>;
  matrix?: EvalRequest["matrix"];
  trials?: number;
};

/** "New run" filled with the defaults of the eval. */
export function runDraftOf(defaults: RunDefaults, params: readonly ParamSpec[]): RunDraft {
  return {
    name: "",
    datasetId: defaults.datasetId,
    addRows: { mode: "none" },
    scorers: null,
    versionId: defaults.versionId,
    params: Object.fromEntries(
      params.map((param) => {
        const value = defaults.params[param.name] ?? param.default;
        return [param.name, param.type === "boolean" ? value === true : String(value ?? "")];
      }),
    ),
    matrix: Object.fromEntries(
      Object.entries(defaults.matrix).map(([name, values]) => [
        name,
        values.map(String).join(", "),
      ]),
    ),
    matrixOn: Object.keys(defaults.matrix).length > 0,
    trials: String(defaults.trials),
  };
}

/**
 * The request of "New run": only what differs from the defaults of the eval, so the run records
 * what it changed. An empty request runs the eval as it is.
 */
export function runRequestOf(
  draft: RunDraft,
  defaults: RunDefaults,
  params: readonly ParamSpec[],
): { ok: true; request: RunRequest } | { ok: false; message: string } {
  const request: RunRequest = {};
  if (draft.name.trim()) request.name = draft.name.trim();
  if (draft.datasetId && draft.datasetId !== defaults.datasetId)
    request.datasetId = draft.datasetId;
  const rows = draft.addRows;
  if (rows.mode === "traces") {
    if (rows.turnIds.length === 0) return { ok: false, message: "Choose the traces to add." };
    request.addRows = { turnIds: rows.turnIds };
  } else if (rows.mode !== "none") {
    const limit = Number(rows.limit.trim());
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return { ok: false, message: "Give a number of traces from 1 to 500." };
    }
    request.addRows = { query: { kind: rows.mode === "last" ? "last_traces" : "auto", limit } };
  }
  if (draft.scorers !== null) {
    if (draft.scorers.length === 0) return { ok: false, message: "Choose at least one scorer." };
    const scorers: EvalRequest["scorers"] = [];
    for (const choice of draft.scorers) {
      const made = scorerOf(choice);
      if (!made.ok) return made;
      scorers.push(made.scorer);
    }
    request.scorers = scorers;
  }
  if (draft.versionId !== defaults.versionId) request.sandboxVersion = draft.versionId;
  const typed = paramsOfDraft(params, draft.params);
  if (!typed.ok) return { ok: false, message: Object.values(typed.errors)[0] ?? "" };
  const matrix = draft.matrixOn ? matrixOf(params, draft.matrix) : null;
  if (matrix && !matrix.ok) return matrix;
  const varied = new Set(Object.keys(matrix?.ok ? matrix.matrix : {}));
  const changed = Object.fromEntries(
    Object.entries(typed.value).filter(
      ([name, value]) =>
        !varied.has(name) && !sameValue(value, defaults.params[name], params, name),
    ),
  );
  if (Object.keys(changed).length > 0) request.params = changed;
  const nextMatrix = matrix?.ok ? matrix.matrix : {};
  if (JSON.stringify(nextMatrix) !== JSON.stringify(defaults.matrix)) request.matrix = nextMatrix;
  const trials = Number(draft.trials.trim());
  if (!Number.isInteger(trials) || trials < 1 || trials > MAX_EVAL_TRIALS) {
    return { ok: false, message: `Give a number of trials from 1 to ${MAX_EVAL_TRIALS}.` };
  }
  if (trials !== defaults.trials) request.trials = trials;
  return { ok: true, request };
}

/** A param equals the default of the eval, or the default of the version when the eval has none. */
function sameValue(
  value: unknown,
  ofEval: unknown,
  params: readonly ParamSpec[],
  name: string,
): boolean {
  const fallback = ofEval ?? params.find((param) => param.name === name)?.default;
  return JSON.stringify(value) === JSON.stringify(fallback);
}
