import { matchesAnyPath, matchesPath } from "../glob";
import { type DiffFile, parseUnifiedDiff } from "./diff";

/**
 * The first change → evals rule (RTL-408): which evals, which of their rows and which past traces
 * best test a commit, from its diff alone. Pure and explainable: each pick says why. A smarter
 * selection (call graphs, spans, embeddings) comes later and keeps this shape.
 *
 * A file outside the agent's folder (`root`, the folder of its ratel.yaml) touches nothing. For
 * every other file, the first rule that applies:
 * 1. the agent's config (`ratel.yaml`): a line that names a declared tool changes that tool; any
 *    other line (model, params, input, secrets) changes every run;
 * 2. a build or system-prompt file (`global`): changes every run;
 * 3. a prompt file: changes the prompt named by its file name;
 * 4. docs, CI and tests (`ignore`): change nothing the agent runs;
 * 5. any other file: changes each declared tool its path or its changed lines name
 *    (`refundOrder` names `refund_order`), and is covered by each eval whose `paths` match it.
 *    A file neither maps is unmapped, unless the decision model read it (`resolved`, filled by
 *    `classify.ts`): as one tool's code, as not the agent's, or as code every run goes through.
 *
 * Then: a global or unmapped change selects every eval and row (missing a regression costs more
 * than a few extra runs). Otherwise an eval is selected by a tool, a prompt or a path, with the
 * rows that use a changed tool, or all its rows when a prompt or a path picked it.
 */

/** An eval as the rule reads it: the tools, prompts and paths it exercises, and its rows. */
export type EvalTarget = {
  id: string;
  name: string;
  /** Every tool its rows exercise: expected calls, checks that name a tool, its traces' calls. */
  tools: string[];
  /** Prompt names (a prompt file's name without its extension). */
  prompts?: string[];
  /** Path patterns it covers, as the repository link's globs. */
  paths?: string[];
  rows: { id: string; tools: string[] }[];
};

/** A past trace, most recent first, with the tools it called. */
export type TraceTarget = { id: string; tools: string[] };

export type SelectionRules = {
  configFile: string;
  global: { pattern: string; why: string }[];
  prompts: string[];
  ignore: string[];
};

export const DEFAULT_RULES: SelectionRules = {
  configFile: "ratel.yaml",
  global: [
    ...[
      "Dockerfile",
      ".dockerignore",
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "pyproject.toml",
      "uv.lock",
      "poetry.lock",
      "requirements*.txt",
      "Cargo.toml",
      "Cargo.lock",
      "go.mod",
      "go.sum",
    ].map((pattern) => ({ pattern, why: "changes the build" })),
    ...["**/prompts/system*", "*system-prompt*", "*system_prompt*"].map((pattern) => ({
      pattern,
      why: "changes the system prompt",
    })),
  ],
  prompts: ["**/prompts/**", "*.prompt", "*.prompt.*"],
  ignore: [
    "*.md",
    "*.mdx",
    "*.txt",
    "LICENSE*",
    ".gitignore",
    "docs/**",
    ".github/**",
    "test/**",
    "tests/**",
    "**/__tests__/**",
    "*.test.*",
    "*.spec.*",
    "*_test.*",
    "test_*.py",
  ],
};

export type ChangeSummary = {
  /** Declared tools the change touches. */
  tools: string[];
  /** Prompt names the change touches. */
  prompts: string[];
  /** Why the change touches every run. */
  global: string[];
  /** Files no rule maps. */
  unmapped: string[];
  /** Files that change nothing the agent runs. */
  ignored: string[];
  /** Files outside the agent's folder, or that the decision model read as not the agent's. */
  outside: string[];
  /** Files the rule could not map and the decision model read, with its confidence. */
  classified: { path: string; as: string; confidence: number }[];
};

/** What the decision model read in a file the rule could not map (`classify.ts`). */
export type Resolution =
  | { kind: "tool"; tool: string; confidence: number }
  | { kind: "outside"; confidence: number }
  | { kind: "shared"; confidence: number };

export type SelectedEval = {
  id: string;
  name: string;
  reasons: string[];
  /** The rows to run: their ids, or every row. */
  rows: "all" | string[];
};

export type Selection = {
  /** `all`: every eval and row; `some`: the ones listed; `none`: nothing to run. */
  mode: "none" | "some" | "all";
  /** One line, for the version page. */
  reason: string;
  change: ChangeSummary;
  evals: SelectedEval[];
  skipped: { id: string; name: string }[];
  /** Changed tools that no eval uses: a gap the page should name. */
  untestedTools: string[];
  /** Past traces to replay, most recent first. */
  traces: string[];
};

export type SelectionInput = {
  diff: string | DiffFile[];
  /** The tools the version declares (its config), so a tool no eval uses still counts. */
  tools: string[];
  evals: EvalTarget[];
  traces: TraceTarget[];
  /**
   * The agent's folder: the folder of its ratel.yaml (`agents/support`), empty for the root. A file
   * outside it touches nothing the agent runs; the rules and the evals' paths read inside it.
   */
  root?: string;
  /** By path, what the decision model read in files the rule could not map. */
  resolved?: Record<string, Resolution>;
  rules?: SelectionRules;
  traceLimit?: number;
};

/** `refund_order`, `refundOrder` and `Refund-Order` are one name. */
const norm = (name: string) => name.toLowerCase().replace(/[_-]/g, "");

const WORD = /[A-Za-z][A-Za-z0-9_-]*/g;
const KEY = /^\s*([A-Za-z0-9_.-]+)\s*:/;

const fileStem = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

const changedLines = (file: DiffFile) => [...file.added, ...file.removed];
const meaningful = (line: string) => line.trim() !== "" && !line.trim().startsWith("#");

export function selectEvals(input: SelectionInput): Selection {
  const rules = input.rules ?? DEFAULT_RULES;
  const files = typeof input.diff === "string" ? parseUnifiedDiff(input.diff) : input.diff;

  const declared = new Map<string, string>();
  for (const tool of [
    ...input.tools,
    ...input.evals.flatMap((e) => [...e.tools, ...e.rows.flatMap((r) => r.tools)]),
    ...input.traces.flatMap((t) => t.tools),
  ]) {
    if (!declared.has(norm(tool))) declared.set(norm(tool), tool);
  }
  const toolsIn = (words: Iterable<string>) => {
    const found = new Set<string>();
    for (const word of words) {
      const tool = declared.get(norm(word));
      if (tool) found.add(tool);
    }
    return found;
  };

  const tools = new Set<string>();
  const prompts = new Set<string>();
  const global: string[] = [];
  const unmapped: string[] = [];
  const ignored: string[] = [];
  const outside: string[] = [];
  const classified: ChangeSummary["classified"] = [];
  const root = (input.root ?? "").replace(/^\.\/?/, "").replace(/\/+$/, "");
  const inRoot = (path: string) =>
    root === "" ? path : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
  /** Per eval, the changed files its paths cover. */
  const covered = new Map<string, string[]>();
  const addGlobal = (why: string) => {
    if (!global.includes(why)) global.push(why);
  };

  for (const file of files) {
    // The rules read each path from the agent's folder; the summary names it from the root.
    const paths = [file.path, ...(file.oldPath && file.oldPath !== file.path ? [file.oldPath] : [])]
      .map(inRoot)
      .filter((path): path is string => path !== null);
    if (paths.length === 0) {
      outside.push(file.path);
      continue;
    }

    if (paths.some((path) => matchesPath(rules.configFile, path))) {
      for (const line of changedLines(file).filter(meaningful)) {
        const named = toolsIn(line.match(WORD) ?? []);
        if (named.size > 0) for (const tool of named) tools.add(tool);
        else addGlobal(`${file.path} changes ${KEY.exec(line)?.[1] ?? "its settings"}`);
      }
      continue;
    }

    const build = rules.global.find((rule) =>
      paths.some((path) => matchesPath(rule.pattern, path)),
    );
    if (build) {
      addGlobal(`${file.path} ${build.why}`);
      continue;
    }

    if (paths.some((path) => matchesAnyPath(rules.prompts, path))) {
      prompts.add(fileStem(paths[0]));
      continue;
    }

    if (paths.every((path) => matchesAnyPath(rules.ignore, path))) {
      ignored.push(file.path);
      continue;
    }

    const named = toolsIn([
      ...paths.flatMap((path) => path.split(/[/.]/)),
      ...changedLines(file).flatMap((line) => line.match(WORD) ?? []),
    ]);
    for (const tool of named) tools.add(tool);

    let mapped = named.size > 0;
    for (const evaluation of input.evals) {
      if (paths.some((path) => matchesAnyPath(evaluation.paths ?? [], path))) {
        covered.set(evaluation.id, [...(covered.get(evaluation.id) ?? []), file.path]);
        mapped = true;
      }
    }
    if (mapped) continue;

    const resolution = input.resolved?.[file.path];
    if (!resolution) {
      unmapped.push(file.path);
      continue;
    }
    if (resolution.kind === "tool") {
      tools.add(declared.get(norm(resolution.tool)) ?? resolution.tool);
    } else if (resolution.kind === "outside") {
      outside.push(file.path);
    } else {
      addGlobal(`${file.path} is code every run goes through`);
    }
    classified.push({
      path: file.path,
      as: resolution.kind === "tool" ? resolution.tool : resolution.kind,
      confidence: resolution.confidence,
    });
  }

  const change: ChangeSummary = {
    tools: [...tools].sort(),
    prompts: [...prompts].sort(),
    global,
    unmapped,
    ignored,
    outside,
    classified,
  };
  const limit = input.traceLimit ?? 20;
  const changedTool = (names: string[]) =>
    names.some((name) => tools.has(declared.get(norm(name)) ?? name));

  // A prompt no eval names may be part of every run: treat it as unmapped.
  const promptsUsed = new Set(input.evals.flatMap((e) => (e.prompts ?? []).map(norm)));
  const orphanPrompts = change.prompts.filter((prompt) => !promptsUsed.has(norm(prompt)));

  if (global.length > 0 || unmapped.length > 0 || orphanPrompts.length > 0) {
    const why = [
      ...global,
      ...unmapped.map((path) => `${path} changed and no eval maps to it`),
      ...orphanPrompts.map((prompt) => `the prompt ${prompt} changed and no eval names it`),
    ];
    return everyEval(input, why, change);
  }

  const evals: SelectedEval[] = [];
  const skipped: { id: string; name: string }[] = [];
  for (const evaluation of input.evals) {
    const viaTools = change.tools.filter((tool) =>
      [...evaluation.tools, ...evaluation.rows.flatMap((r) => r.tools)].some(
        (t) => norm(t) === norm(tool),
      ),
    );
    const viaPrompts = change.prompts.filter((prompt) =>
      (evaluation.prompts ?? []).some((p) => norm(p) === norm(prompt)),
    );
    const viaPaths = covered.get(evaluation.id) ?? [];
    if (viaTools.length + viaPrompts.length + viaPaths.length === 0) {
      skipped.push({ id: evaluation.id, name: evaluation.name });
      continue;
    }
    const toolRows = evaluation.rows.filter((row) => changedTool(row.tools)).map((row) => row.id);
    evals.push({
      id: evaluation.id,
      name: evaluation.name,
      reasons: [
        ...viaTools.map((tool) => `uses ${tool}`),
        ...viaPrompts.map((prompt) => `uses the prompt ${prompt}`),
        ...viaPaths.map((path) => `covers ${path}`),
      ],
      // A tool picked it: the rows that call the tool, or all when only its traces do.
      rows: viaPrompts.length + viaPaths.length > 0 || toolRows.length === 0 ? "all" : toolRows,
    });
  }

  const usedTools = new Set(
    input.evals.flatMap((e) => [...e.tools, ...e.rows.flatMap((r) => r.tools)].map(norm)),
  );
  const untestedTools = change.tools.filter((tool) => !usedTools.has(norm(tool)));
  const traces = input.traces
    .filter((trace) => changedTool(trace.tools))
    .slice(0, limit)
    .map((t) => t.id);

  return {
    mode: evals.length > 0 ? "some" : "none",
    reason: reasonOf(evals, change, untestedTools),
    change,
    evals,
    skipped,
    untestedTools,
    traces,
  };
}

function reasonOf(evals: SelectedEval[], change: ChangeSummary, untested: string[]): string {
  const gaps = untested.map((tool) => `${tool} changed, and no eval uses it`);
  if (evals.length > 0) {
    const picked = `${evals.length} eval${evals.length === 1 ? "" : "s"} touched by ${[
      ...change.tools,
      ...change.prompts,
    ]
      .concat(change.tools.length + change.prompts.length === 0 ? ["the changed paths"] : [])
      .join(", ")}`;
    return [picked, ...gaps].join("; ");
  }
  if (gaps.length > 0) return `No eval runs: ${gaps.join("; ")}.`;
  return "No eval runs: the change touches nothing the agent runs.";
}

const NO_CHANGE: ChangeSummary = {
  tools: [],
  prompts: [],
  global: [],
  unmapped: [],
  ignored: [],
  outside: [],
  classified: [],
};

/** Every eval and row, and the most recent traces, with why. */
export function everyEval(
  input: Pick<SelectionInput, "evals" | "traces" | "traceLimit">,
  why: string[],
  change: ChangeSummary = NO_CHANGE,
): Selection {
  return {
    mode: input.evals.length > 0 ? "all" : "none",
    reason: `Every eval runs: ${why.join("; ")}.`,
    change,
    evals: input.evals.map((e) => ({ id: e.id, name: e.name, reasons: why, rows: "all" })),
    skipped: [],
    untestedTools: [],
    traces: input.traces.slice(0, input.traceLimit ?? 20).map((t) => t.id),
  };
}
