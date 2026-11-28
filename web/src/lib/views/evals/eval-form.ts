import { type ParamDraft, type ParamSpec, paramsOfDraft } from "@/lib/views/sandboxes/run-form";
import { type DatasetQuery, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT } from "./domain/dataset";
import {
  combinationCount,
  DEFAULT_EVAL_TRIALS,
  MAX_COMBINATIONS,
  MAX_EVAL_NAME_CHARS,
  MAX_EVAL_TRIALS,
  type ScorerRef,
} from "./domain/eval";
import type { LibraryEntry } from "./scorer-library";

/**
 * The rules of the "New eval" and "New run" dialogs (decisions `runs-per-eval`, `scorer-library`).
 * Pure: the client imports it, and the session routes take what it makes. A dialog keeps text;
 * these functions read the text, refuse it with a reason for each field, or give the request.
 */

/** A sandbox of the project and its ready versions, the newest first. */
export type SandboxOption = {
  name: string;
  versions: Array<{ id: string; label: string; params: ParamSpec[] }>;
};

export type RuntimeDraft =
  | { kind: "sandbox"; sandboxName: string; version: "latest" | string }
  /** Runs against the production agent: not built yet ("coming soon"). */
  | { kind: "production" };

export type DatasetDraft =
  | { kind: "existing"; datasetId: string }
  | { kind: "last_traces"; limit: string }
  | { kind: "task_traces"; taskId: string; limit: string }
  | { kind: "rql"; text: string; limit: string }
  | { kind: "auto"; taskId: string; limit: string };

/** A scorer chosen in the picker: a library entry (`<source>:<id>`) with its settings. */
export type ScorerPick = {
  key: string;
  gating: boolean;
  settings: Record<string, string>;
};

/** For each param of the matrix, its values as the person types them, separated by commas. */
export type MatrixDraft = Record<string, string>;

export type EvalDraft = {
  name: string;
  /** Empty: no task. */
  taskId: string;
  runtime: RuntimeDraft;
  dataset: DatasetDraft;
  params: ParamDraft;
  matrixOn: boolean;
  matrix: MatrixDraft;
  scorers: ScorerPick[];
  trials: string;
};

export type FormContext = {
  sandboxes: readonly SandboxOption[];
  library: readonly LibraryEntry[];
};

/** A scorer of a request: a library reference with the name and the id it has in the eval. */
export type ScorerBody = { id: string; name: string; gating: boolean; ref: ScorerRef };

export type DatasetBody =
  | { datasetId: string }
  | { query: Exclude<DatasetQuery, { kind: "fixed" }> };

export type NewEvalBody = {
  name: string;
  taskId: string | null;
  sandboxName: string;
  sandboxVersionId: string | null;
  dataset: DatasetBody;
  params: Record<string, string | number | boolean>;
  matrix: Record<string, Array<string | number | boolean>>;
  trials: number;
  scorers: ScorerBody[];
};

export type Errors = Record<string, string>;
export type Checked<T> = { ok: true; body: T } | { ok: false; errors: Errors };

export const PRODUCTION_SOON = "Production agent is coming soon. Choose a sandbox.";

/** A new draft: the first sandbox at its newest ready version, the eval's own query empty. */
export function emptyEvalDraft(ctx: FormContext, datasetId: string | null): EvalDraft {
  const first = ctx.sandboxes[0];
  return {
    name: "",
    taskId: "",
    runtime: first
      ? { kind: "sandbox", sandboxName: first.name, version: "latest" }
      : { kind: "production" },
    dataset: datasetId
      ? { kind: "existing", datasetId }
      : { kind: "last_traces", limit: String(DEFAULT_ROW_LIMIT) },
    params: {},
    matrixOn: false,
    matrix: {},
    scorers: [],
    trials: String(DEFAULT_EVAL_TRIALS),
  };
}

/** The params that the chosen runtime declares: those of its pinned version, else its newest. */
export function runtimeParams(ctx: FormContext, runtime: RuntimeDraft): ParamSpec[] {
  if (runtime.kind !== "sandbox") return [];
  const sandbox = ctx.sandboxes.find(({ name }) => name === runtime.sandboxName);
  const version =
    runtime.version === "latest"
      ? sandbox?.versions[0]
      : sandbox?.versions.find(({ id }) => id === runtime.version);
  return version?.params ?? [];
}

/** The values of each param of the matrix, typed as the runtime declares them. */
export function matrixOf(
  params: readonly ParamSpec[],
  draft: MatrixDraft,
):
  | { ok: true; matrix: Record<string, Array<string | number | boolean>>; count: number }
  | { ok: false; errors: Errors; count: number } {
  const matrix: Record<string, Array<string | number | boolean>> = {};
  const errors: Errors = {};
  for (const param of params) {
    const texts = splitValues(draft[param.name] ?? "");
    if (texts.length === 0) continue;
    const values: Array<string | number | boolean> = [];
    for (const text of texts) {
      const value = typedValue(param, text);
      if (value === undefined) {
        errors[`matrix.${param.name}`] = valueProblem(param);
        break;
      }
      if (!values.includes(value)) values.push(value);
    }
    matrix[param.name] = values;
  }
  const count = Object.keys(matrix).length === 0 ? 0 : combinationCount(matrix);
  if (Object.keys(errors).length > 0) return { ok: false, errors, count };
  if (count < 2) {
    return {
      ok: false,
      errors: { matrix: "A matrix tries at least two combinations. Give a param two values." },
      count,
    };
  }
  if (count > MAX_COMBINATIONS) {
    return {
      ok: false,
      errors: {
        matrix: `A matrix has at most ${MAX_COMBINATIONS} combinations, and this one has ${count}. Remove values.`,
      },
      count,
    };
  }
  return { ok: true, matrix, count };
}

/** The request of "New eval", or the reason of each field that refuses it. */
export function checkEvalDraft(draft: EvalDraft, ctx: FormContext): Checked<NewEvalBody> {
  const errors: Errors = {};
  const name = draft.name.trim();
  if (name === "") errors.name = "Give the eval a name.";
  else if (name.length > MAX_EVAL_NAME_CHARS) {
    errors.name = `A name has at most ${MAX_EVAL_NAME_CHARS} characters.`;
  }
  const runtime = checkRuntime(draft.runtime, ctx, errors);
  const dataset = checkDataset(draft.dataset, errors);
  const params = runtimeParams(ctx, draft.runtime);
  const typed = paramsOfDraft(params, draft.params);
  if (!typed.ok)
    for (const [key, value] of Object.entries(typed.errors)) errors[`params.${key}`] = value;
  let matrix: NewEvalBody["matrix"] = {};
  if (draft.matrixOn) {
    const made = matrixOf(params, draft.matrix);
    if (made.ok) matrix = made.matrix;
    else Object.assign(errors, made.errors);
  }
  const scorers = checkScorers(draft.scorers, ctx.library, errors);
  const trials = checkTrials(draft.trials, errors);
  if (Object.keys(errors).length > 0 || !runtime || !dataset || !typed.ok || !scorers) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    body: {
      name,
      taskId: draft.taskId.trim() === "" ? null : draft.taskId.trim(),
      sandboxName: runtime.sandboxName,
      sandboxVersionId: runtime.versionId,
      dataset,
      // A param of the matrix takes its values there.
      params: Object.fromEntries(Object.entries(typed.value).filter(([key]) => !(key in matrix))),
      matrix,
      trials: trials ?? DEFAULT_EVAL_TRIALS,
      scorers,
    },
  };
}

function checkRuntime(runtime: RuntimeDraft, ctx: FormContext, errors: Errors) {
  if (runtime.kind === "production") {
    errors.runtime = PRODUCTION_SOON;
    return null;
  }
  const sandbox = ctx.sandboxes.find(({ name }) => name === runtime.sandboxName);
  if (!sandbox) {
    errors.runtime =
      ctx.sandboxes.length === 0
        ? "The project has no sandbox with a ready version. Push one first."
        : "Choose a sandbox.";
    return null;
  }
  if (runtime.version !== "latest" && !sandbox.versions.some(({ id }) => id === runtime.version)) {
    errors.runtime = "Choose a ready version of the sandbox.";
    return null;
  }
  return {
    sandboxName: sandbox.name,
    versionId: runtime.version === "latest" ? null : runtime.version,
  };
}

export function checkDataset(dataset: DatasetDraft, errors: Errors): DatasetBody | null {
  if (dataset.kind === "existing") {
    if (dataset.datasetId === "") {
      errors.dataset = "Choose a dataset.";
      return null;
    }
    return { datasetId: dataset.datasetId };
  }
  const limit = checkLimit(dataset.limit, errors);
  if (limit === null) return null;
  switch (dataset.kind) {
    case "last_traces":
      return { query: { kind: "last_traces", limit } };
    case "task_traces":
      if (dataset.taskId.trim() === "") {
        errors.dataset = "Choose a task.";
        return null;
      }
      return { query: { kind: "task_traces", taskId: dataset.taskId.trim(), limit } };
    case "rql":
      if (dataset.text.trim() === "") {
        errors.dataset = "Write the query. It must give a trace_id column.";
        return null;
      }
      return { query: { kind: "rql", text: dataset.text.trim(), limit } };
    case "auto":
      return {
        query: {
          kind: "auto",
          taskId: dataset.taskId.trim() === "" ? null : dataset.taskId.trim(),
          limit,
        },
      };
  }
}

function checkLimit(text: string, errors: Errors): number | null {
  const limit = Number(text);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROW_LIMIT) {
    errors.limit = `The number of traces is from 1 to ${MAX_ROW_LIMIT}.`;
    return null;
  }
  return limit;
}

export function checkTrials(text: string, errors: Errors): number | null {
  const trials = Number(text);
  if (!Number.isInteger(trials) || trials < 1 || trials > MAX_EVAL_TRIALS) {
    errors.trials = `Trials are from 1 to ${MAX_EVAL_TRIALS}.`;
    return null;
  }
  return trials;
}

/**
 * The scorers as library references, each with an id that is unique in the eval. A pre-defined
 * scorer needs each of its settings. At least one scorer must decide the result of a trial.
 */
export function checkScorers(
  picks: readonly ScorerPick[],
  library: readonly LibraryEntry[],
  errors: Errors,
): ScorerBody[] | null {
  if (picks.length === 0) {
    errors.scorers = "Choose at least one scorer.";
    return null;
  }
  const made: ScorerBody[] = [];
  const ids = new Set<string>();
  for (const pick of picks) {
    const entry = library.find((one) => libraryKey(one) === pick.key);
    if (!entry || entry.source === "eval") {
      errors.scorers = "A chosen scorer is not in the library any more.";
      return null;
    }
    if (!entry.usable) {
      errors.scorers = `"${entry.name}" cannot score a trial: ${entry.why ?? "it is not usable."}`;
      return null;
    }
    const settings: Record<string, string | number> = {};
    for (const setting of entry.settings) {
      const text = (pick.settings[setting.name] ?? "").trim();
      const value = setting.type === "number" ? Number(text) : text;
      if (text === "" || (typeof value === "number" && !Number.isFinite(value))) {
        errors[`scorer.${pick.key}.${setting.name}`] =
          setting.type === "number"
            ? `"${entry.name}" needs a number: ${setting.description.toLowerCase()}`
            : `"${entry.name}" needs this: ${setting.description.toLowerCase()}`;
        continue;
      }
      settings[setting.name] = value;
    }
    const id = uniqueId(
      entry.source === "predefined" ? entry.id : `scorer-${entry.id.slice(0, 8)}`,
      ids,
    );
    const ref: ScorerRef =
      entry.source === "predefined"
        ? {
            source: "predefined",
            key: entry.id as Extract<ScorerRef, { source: "predefined" }>["key"],
            settings,
          }
        : { source: "project", scorerId: entry.id };
    made.push({ id, name: scorerName(entry, settings), gating: pick.gating, ref });
  }
  if (!made.some(({ gating }) => gating)) {
    errors.scorers = "Make at least one scorer decide the result of a trial.";
  }
  return Object.keys(errors).some((key) => key === "scorers" || key.startsWith("scorer."))
    ? null
    : made;
}

/** The key of an entry of the scorer library in the picker. */
export function libraryKey(entry: Pick<LibraryEntry, "source" | "id">): string {
  return `${entry.source}:${entry.id}`;
}

/** The picker groups: the project's scorers, then the pre-defined set. Each matches the search. */
export function scorerGroups(
  library: readonly LibraryEntry[],
  search: string,
): Array<{ label: string; entries: LibraryEntry[] }> {
  const wanted = search.trim().toLowerCase();
  const matches = (entry: LibraryEntry) =>
    wanted === "" ||
    entry.name.toLowerCase().includes(wanted) ||
    (entry.description ?? "").toLowerCase().includes(wanted);
  return [
    { label: "This project", entries: library.filter((e) => e.source === "project" && matches(e)) },
    {
      label: "Pre-defined",
      entries: library.filter((e) => e.source === "predefined" && matches(e)),
    },
  ];
}

/** Values separated by commas. A value with a comma in it is not possible here. */
export function splitValues(text: string): string[] {
  return text
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

function typedValue(param: ParamSpec, text: string): string | number | boolean | undefined {
  switch (param.type) {
    case "number": {
      const value = Number(text);
      return Number.isFinite(value) ? value : undefined;
    }
    case "boolean":
      return text === "true" ? true : text === "false" ? false : undefined;
    case "enum":
      return param.options.find((option) => String(option) === text);
    case "string":
      return text;
  }
}

function valueProblem(param: ParamSpec): string {
  switch (param.type) {
    case "number":
      return `Each value of ${param.name} must be a number.`;
    case "boolean":
      return `Each value of ${param.name} is true or false.`;
    case "enum":
      return `Each value of ${param.name} is one of: ${param.options.join(", ")}.`;
    case "string":
      return `Give ${param.name} a value.`;
  }
}

/** A pre-defined scorer with a setting names it: "Output contains: refund". */
function scorerName(entry: LibraryEntry, settings: Record<string, string | number>): string {
  const values = Object.values(settings);
  const name = values.length === 0 ? entry.name : `${entry.name}: ${values.join(", ")}`;
  return name.slice(0, 100);
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base.slice(0, 90);
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 90)}-${n}`;
  taken.add(id);
  return id;
}

// — New run ————————————————————————————————————————————————————————————————————

/** Rows that one run adds for itself: chosen trace turns, the last N traces, or Ratel's choice. */
export type AddRowsDraft =
  | { kind: "none" }
  | { kind: "turns"; turnIds: string[] }
  | { kind: "last_traces"; limit: string }
  | { kind: "auto"; limit: string };

export type RunDraft = {
  name: string;
  /** The dataset of the run. The eval's own dataset is the default. */
  datasetId: string;
  addRows: AddRowsDraft;
  /** False: the scorers of the eval. */
  scorersChanged: boolean;
  scorers: ScorerPick[];
  /** `default`: the runtime of the eval. `latest`: the newest ready version. Else a version id. */
  version: "default" | "latest" | string;
  params: ParamDraft;
  matrixOn: boolean;
  matrix: MatrixDraft;
  trials: string;
};

/** What the eval runs with, unless a run changes it. */
export type RunDefaults = {
  datasetId: string;
  sandboxName: string | null;
  /** The pinned version of the eval. Null: the newest ready version. */
  versionId: string | null;
  params: Record<string, unknown>;
  matrix: Record<string, unknown[]>;
  trials: number;
  /** The scorers of the eval that the library has. A scorer kept in the eval has no pick. */
  scorers: ScorerPick[];
};

export type RowsBody =
  | { kind: "turns"; turnIds: string[] }
  | { kind: "last_traces" | "auto"; limit: number };

/** Only what the run changes: the rest comes from the eval. */
export type NewRunBody = {
  name?: string;
  dataset?: string;
  rows?: RowsBody;
  scorers?: ScorerBody[];
  sandboxVersion?: string;
  params?: Record<string, string | number | boolean>;
  matrix?: Record<string, Array<string | number | boolean>>;
  trials?: number;
};

/** The most trace turns that a person picks for one run. */
export const MAX_PICKED_TURNS = 100;

/** The dialog at the defaults of the eval. */
export function runDraftOf(defaults: RunDefaults): RunDraft {
  const matrixOn = Object.keys(defaults.matrix).length > 0;
  return {
    name: "",
    datasetId: defaults.datasetId,
    addRows: { kind: "none" },
    scorersChanged: false,
    scorers: defaults.scorers,
    version: "default",
    params: Object.fromEntries(
      Object.entries(defaults.params).map(([key, value]) => [
        key,
        typeof value === "boolean" ? value : String(value ?? ""),
      ]),
    ),
    matrixOn,
    matrix: Object.fromEntries(
      Object.entries(defaults.matrix).map(([key, values]) => [key, values.map(String).join(", ")]),
    ),
    trials: String(defaults.trials),
  };
}

/** The request of "New run": each change against the defaults, or the reason of each field. */
export function checkRunDraft(
  draft: RunDraft,
  defaults: RunDefaults,
  ctx: FormContext,
): Checked<NewRunBody> {
  const errors: Errors = {};
  const body: NewRunBody = {};
  const name = draft.name.trim();
  if (name.length > 200) errors.name = "A name has at most 200 characters.";
  else if (name !== "") body.name = name;
  if (draft.datasetId === "") errors.dataset = "Choose a dataset.";
  else if (draft.datasetId !== defaults.datasetId) body.dataset = draft.datasetId;
  const rows = checkAddRows(draft.addRows, errors);
  if (rows) body.rows = rows;
  if (draft.scorersChanged) {
    const scorers = checkScorers(draft.scorers, ctx.library, errors);
    if (scorers) body.scorers = scorers;
  }
  const sandbox = ctx.sandboxes.find(({ name: one }) => one === defaults.sandboxName);
  const version = draft.version === "default" ? (defaults.versionId ?? "latest") : draft.version;
  if (version !== "latest" && sandbox && !sandbox.versions.some(({ id }) => id === version)) {
    errors.version = "Choose a ready version of the sandbox.";
  } else if (version !== (defaults.versionId ?? "latest")) {
    body.sandboxVersion = version;
  }
  const params = runtimeParams(
    ctx,
    defaults.sandboxName
      ? { kind: "sandbox", sandboxName: defaults.sandboxName, version }
      : { kind: "production" },
  );
  let matrix: NewRunBody["matrix"] = {};
  if (draft.matrixOn) {
    const made = matrixOf(params, draft.matrix);
    if (made.ok) matrix = made.matrix;
    else Object.assign(errors, made.errors);
  }
  if (!sameJson(matrix, defaults.matrix)) body.matrix = matrix;
  const typed = paramsOfDraft(params, draft.params);
  if (!typed.ok) {
    for (const [key, value] of Object.entries(typed.errors)) errors[`params.${key}`] = value;
  } else {
    const changed = Object.fromEntries(
      Object.entries(typed.value).filter(
        ([key, value]) => !(key in matrix) && !sameJson(value, defaults.params[key]),
      ),
    );
    if (Object.keys(changed).length > 0) body.params = changed;
  }
  const trials = checkTrials(draft.trials, errors);
  if (trials !== null && trials !== defaults.trials) body.trials = trials;
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, body };
}

function checkAddRows(draft: AddRowsDraft, errors: Errors): RowsBody | null {
  switch (draft.kind) {
    case "none":
      return null;
    case "turns":
      if (draft.turnIds.length === 0) {
        errors.rows = "Choose at least one trace.";
        return null;
      }
      if (draft.turnIds.length > MAX_PICKED_TURNS) {
        errors.rows = `Choose at most ${MAX_PICKED_TURNS} traces.`;
        return null;
      }
      return { kind: "turns", turnIds: [...new Set(draft.turnIds)] };
    case "last_traces":
    case "auto": {
      const limit = checkLimit(draft.limit, errors);
      return limit === null ? null : { kind: draft.kind, limit };
    }
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// — New dataset ————————————————————————————————————————————————————————————————

/** A fixed dataset, empty or from chosen traces, or one query kind. */
export type NewDatasetDraft = {
  name: string;
  description: string;
  kind: "fixed" | Exclude<DatasetDraft["kind"], "existing">;
  turnIds: string[];
  limit: string;
  taskId: string;
  text: string;
};

export type NewDatasetBody = {
  name: string;
  description: string | null;
  query: DatasetQuery;
  turnIds?: string[];
};

export function emptyDatasetDraft(): NewDatasetDraft {
  return {
    name: "",
    description: "",
    kind: "fixed",
    turnIds: [],
    limit: String(DEFAULT_ROW_LIMIT),
    taskId: "",
    text: "",
  };
}

/** The query draft of a kind, for the fields that a query kind shares with "New eval". */
export function queryDraftOf(
  draft: NewDatasetDraft,
): Exclude<DatasetDraft, { kind: "existing" }> | null {
  switch (draft.kind) {
    case "fixed":
      return null;
    case "last_traces":
      return { kind: "last_traces", limit: draft.limit };
    case "task_traces":
      return { kind: "task_traces", taskId: draft.taskId, limit: draft.limit };
    case "rql":
      return { kind: "rql", text: draft.text, limit: draft.limit };
    case "auto":
      return { kind: "auto", taskId: draft.taskId, limit: draft.limit };
  }
}

export function checkDatasetDraft(draft: NewDatasetDraft): Checked<NewDatasetBody> {
  const errors: Errors = {};
  const name = draft.name.trim();
  if (name === "") errors.name = "Give the dataset a name.";
  else if (name.length > 100) errors.name = "A name has at most 100 characters.";
  const description = draft.description.trim() === "" ? null : draft.description.trim();
  const queryDraft = queryDraftOf(draft);
  let query: DatasetQuery = { kind: "fixed" };
  if (queryDraft) {
    const made = checkDataset(queryDraft, errors);
    if (made && "query" in made) query = made.query;
  } else if (draft.turnIds.length > MAX_PICKED_TURNS) {
    errors.rows = `Choose at most ${MAX_PICKED_TURNS} traces.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      name,
      description,
      query,
      ...(query.kind === "fixed" && draft.turnIds.length > 0 ? { turnIds: draft.turnIds } : {}),
    },
  };
}
