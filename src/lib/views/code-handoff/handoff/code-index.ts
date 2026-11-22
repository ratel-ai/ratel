import { and, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { listSyncedTools } from "@/lib/ingest/catalogs/queries";
import { systemFromInstructions } from "@/lib/ingest/otlp/content";
import { otelSpans } from "@/lib/ingest/otlp/schema";
import { INDEX_REPO_CODE_JOB } from "@/lib/jobs/kinds";
import { enqueueJob, findInFlightJob } from "@/lib/jobs/queries";
import { jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import type { RepoCodePointerKind, RepoLinkRow } from "@/lib/views/code-handoff/schema";
import { loadFixes } from "@/lib/views/fixes/load";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import { readGitHubAppConfig } from "../config";
import type { GitHubPort } from "../ports";
import {
  getRepoLink,
  type NewCodePointer,
  pruneCodePointers,
  replaceSymbolPointers,
} from "../store";
import { gitHubFor } from "../wiring";

/**
 * The code index (RC-917): where in a linked repo the project's tool names,
 * model ids and system prompts are, so a handoff brief can point the coding
 * agent at them. Only `{kind, symbol, path, line}` is kept: a file is read
 * through the port, its first matching line is found in memory, and the text
 * is dropped. Neither rows nor log lines carry file content.
 *
 * GitHub code search allows about 10 requests a minute and indexes only the
 * default branch, so the index runs as a job of `INDEX_BUDGET` symbols per run
 * (one search each). A run that has more symbols, or that GitHub rate-limits
 * (403/429), queues the next run with its offset and keeps what it found; the
 * next drain (at most a minute later) continues. Prompts are indexed only
 * when the project allows Ratel to read content (`contentOptIn`).
 */

export type IndexSymbol = { kind: RepoCodePointerKind; symbol: string };

/** Where a run starts: the link it indexes and the symbol it continues from. */
export interface CodeIndexPayload {
  linkId: string;
  offset: number;
}

export interface CodeIndexDeps {
  github: GitHubPort;
  getRepoLink: (
    projectId: string,
  ) => Promise<Pick<RepoLinkRow, "id" | "installationId" | "owner" | "name"> | null>;
  /** The symbols to find, in the order to find them (`orderSymbols`). */
  listSymbols: (projectId: string) => Promise<IndexSymbol[]>;
  /** Replace the pointers of one symbol (none when nothing matched). */
  replaceSymbolPointers: (
    linkId: string,
    symbol: IndexSymbol,
    pointers: NewCodePointer[],
  ) => Promise<void>;
  /** Drop the pointers of every symbol not in `keep`. */
  prunePointers: (linkId: string, keep: readonly IndexSymbol[]) => Promise<void>;
  requeue: (projectId: string, payload: CodeIndexPayload) => Promise<void>;
  log: (level: "info" | "warn", fields: Record<string, unknown>, message: string) => void;
  /** Symbols per run; `INDEX_BUDGET` by default. */
  budget?: number;
}

export interface CodeIndexResult {
  outcome: "no_link" | "complete" | "partial" | "rate_limited";
  /** Symbols indexed by this run. */
  indexed: number;
  /** Pointers this run stored. */
  pointers: number;
  /** Symbols left for the next run. */
  remaining: number;
}

export interface EnqueueCodeIndexDeps {
  hasLink: (projectId: string) => Promise<boolean>;
  inFlight: (projectId: string) => Promise<boolean>;
  /** Whether an index run was queued within `ms`. */
  ranWithin: (projectId: string, ms: number) => Promise<boolean>;
  enqueue: (projectId: string) => Promise<void>;
}

/** Symbols per run: code search allows about 10 requests a minute. */
export const INDEX_BUDGET = 8;
/** At handoff, an index older than this is refreshed in the background. */
export const INDEX_STALE_MS = 24 * 60 * 60 * 1000;
/** Files kept per symbol. */
const MAX_HITS = 3;
const MAX_TOOLS = 50;
const MAX_MODELS = 10;
const MAX_PROMPTS = 5;
const MODEL_WINDOW_DAYS = 14;
const PROMPT_SLICE_MIN = 24;
const PROMPT_SLICE_MAX = 60;
const RATE_LIMITED = /\bstatus (403|429)\b/;

const logger = getLogger("code-handoff/code-index");

/** One index run: up to the budget of symbols from the payload's offset. */
export async function runCodeIndex(
  projectId: string,
  rawPayload: unknown,
  deps: CodeIndexDeps,
): Promise<CodeIndexResult> {
  const link = await deps.getRepoLink(projectId);
  if (!link) return { outcome: "no_link", indexed: 0, pointers: 0, remaining: 0 };
  const payload = parseCodeIndexPayload(rawPayload);
  // A run queued for an earlier link starts over on the current one.
  const offset = payload && payload.linkId === link.id ? payload.offset : 0;
  const symbols = await deps.listSymbols(projectId);
  const end = Math.min(symbols.length, offset + (deps.budget ?? INDEX_BUDGET));
  const repo = { owner: link.owner, name: link.name };
  let stored = 0;
  let at = offset;
  const finish = (outcome: CodeIndexResult["outcome"]): CodeIndexResult => {
    const result = {
      outcome,
      indexed: at - offset,
      pointers: stored,
      remaining: symbols.length - at,
    };
    deps.log(
      "info",
      { project_id: projectId, link_id: link.id, ...result },
      "code index run finished",
    );
    return result;
  };

  for (; at < end; at++) {
    const symbol = symbols[at]!;
    let pointers: NewCodePointer[];
    try {
      pointers = await findSymbol(deps.github, link.installationId, repo, symbol);
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      deps.log(
        "warn",
        { project_id: projectId, link_id: link.id, offset: at },
        "code index rate limited",
      );
      await deps.requeue(projectId, { linkId: link.id, offset: at });
      return finish("rate_limited");
    }
    await deps.replaceSymbolPointers(link.id, symbol, pointers);
    stored += pointers.length;
  }

  if (at < symbols.length) {
    await deps.requeue(projectId, { linkId: link.id, offset: at });
    return finish("partial");
  }
  await deps.prunePointers(link.id, symbols);
  return finish("complete");
}

/**
 * Queue an index run unless one is queued or running. With `staleAfterMs` (at
 * handoff), only when the last run is older than that.
 */
export async function enqueueCodeIndex(
  projectId: string,
  options: { staleAfterMs?: number },
  deps: EnqueueCodeIndexDeps = defaultEnqueueDeps,
): Promise<"queued" | "in_flight" | "fresh" | "no_link"> {
  if (!(await deps.hasLink(projectId))) return "no_link";
  if (await deps.inFlight(projectId)) return "in_flight";
  if (options.staleAfterMs !== undefined && (await deps.ranWithin(projectId, options.staleAfterMs)))
    return "fresh";
  await deps.enqueue(projectId);
  return "queued";
}

/** Tools of open fixes first, then the catalog's tools, the models and the prompts; each once. */
export function orderSymbols(input: {
  fixTools: readonly string[];
  tools: readonly string[];
  models: readonly string[];
  prompts: readonly string[];
}): IndexSymbol[] {
  const seen = new Set<string>();
  const out: IndexSymbol[] = [];
  const add = (kind: RepoCodePointerKind, symbol: string) => {
    const key = `${kind}:${symbol}`;
    if (symbol.trim().length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push({ kind, symbol });
  };
  for (const tool of input.fixTools) add("tool", tool);
  for (const tool of input.tools.slice(0, MAX_TOOLS)) add("tool", tool);
  for (const model of input.models.slice(0, MAX_MODELS)) add("model", model);
  for (const prompt of input.prompts.slice(0, MAX_PROMPTS)) add("prompt", prompt);
  return out;
}

/** The first line of `text` that contains `symbol`, 1-based; null when none does. */
export function firstLineOf(text: string, symbol: string): number | null {
  const index = text.split(/\r?\n/).findIndex((line) => line.includes(symbol));
  return index < 0 ? null : index + 1;
}

/**
 * A short, distinctive slice of a system prompt to search for: its first line
 * long enough to be unique, without quotes (they would break the phrase
 * query), cut at a word boundary. Null when no line is long enough.
 */
export function promptSlice(prompt: string): string | null {
  for (const raw of prompt.split(/\r?\n/)) {
    const line = raw.replace(/["\\]/g, "").replace(/\s+/g, " ").trim();
    if (line.length < PROMPT_SLICE_MIN) continue;
    if (line.length <= PROMPT_SLICE_MAX) return line;
    const cut = line.slice(0, PROMPT_SLICE_MAX);
    const space = cut.lastIndexOf(" ");
    return (space >= PROMPT_SLICE_MIN ? cut.slice(0, space) : cut).trim();
  }
  return null;
}

export function parseCodeIndexPayload(raw: unknown): CodeIndexPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const { linkId, offset } = raw as Record<string, unknown>;
  if (
    typeof linkId !== "string" ||
    typeof offset !== "number" ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    return null;
  return { linkId, offset };
}

/* - One symbol ------------------------------------------------------------------ */

/** The files that name a symbol, each with its first matching line. The file text never leaves this function. */
async function findSymbol(
  github: GitHubPort,
  installationId: number,
  repo: { owner: string; name: string },
  symbol: IndexSymbol,
): Promise<NewCodePointer[]> {
  const hits = await github.searchCode(installationId, repo, `"${symbol.symbol}"`);
  const paths = [...new Set(hits.map((hit) => hit.path))].sort().slice(0, MAX_HITS);
  const pointers: NewCodePointer[] = [];
  for (const path of paths) {
    const text = await github.readFile(installationId, { ...repo, path });
    if (text === null) continue;
    pointers.push({
      kind: symbol.kind,
      symbol: symbol.symbol,
      path,
      line: firstLineOf(text, symbol.symbol),
    });
  }
  return pointers;
}

function isRateLimited(error: unknown): boolean {
  return error instanceof Error && RATE_LIMITED.test(error.message);
}

/* - Wiring ---------------------------------------------------------------------- */

/** The job handler's dependencies: the App's client, the store and the project's reads. */
export function codeIndexDeps(): CodeIndexDeps {
  const config = readGitHubAppConfig();
  if (!config) throw new Error("github app is not configured");
  return {
    github: gitHubFor(config),
    getRepoLink: (projectId) => getRepoLink(projectId),
    listSymbols: listIndexSymbols,
    replaceSymbolPointers: (linkId, symbol, pointers) =>
      replaceSymbolPointers(linkId, symbol, pointers),
    prunePointers: (linkId, keep) => pruneCodePointers(linkId, keep),
    requeue: async (projectId, payload) => {
      await enqueueJob({ projectId, kind: INDEX_REPO_CODE_JOB, payload });
    },
    log: (level, fields, message) => logger[level](fields, message),
  };
}

const defaultEnqueueDeps: EnqueueCodeIndexDeps = {
  hasLink: async (projectId) => (await getRepoLink(projectId)) !== null,
  inFlight: async (projectId) => (await findInFlightJob(projectId, INDEX_REPO_CODE_JOB)) !== null,
  ranWithin: async (projectId, ms) => {
    const [row] = await getDb()
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.projectId, projectId),
          eq(jobs.kind, INDEX_REPO_CODE_JOB),
          gt(jobs.createdAt, sql`now() - make_interval(secs => ${ms / 1000})`),
        ),
      )
      .limit(1);
    return row !== undefined;
  },
  enqueue: async (projectId) => {
    await enqueueJob({ projectId, kind: INDEX_REPO_CODE_JOB, payload: null });
  },
};

/** The project's symbols: open fixes' tools, catalog tools, recent models and, with content opt-in, prompt slices. */
async function listIndexSymbols(projectId: string): Promise<IndexSymbol[]> {
  const db = getDb();
  const organization = await getOrganizationByProjectId(projectId);
  const [fixes, tools, models, readContent] = await Promise.all([
    organization ? loadFixes({ projectId, organization, topics: false }) : Promise.resolve(null),
    listSyncedTools(projectId),
    db
      .selectDistinct({ model: otelSpans.model })
      .from(otelSpans)
      .where(
        and(
          eq(otelSpans.projectId, projectId),
          isNotNull(otelSpans.model),
          gt(otelSpans.startedAt, sql`now() - make_interval(days => ${MODEL_WINDOW_DAYS})`),
        ),
      )
      .limit(MAX_MODELS),
    contentOptIn(projectId, db),
  ]);
  const prompts = readContent ? await recentPromptSlices(projectId) : [];
  return orderSymbols({
    fixTools: (fixes?.open ?? []).flatMap((fix) => fix.subject.tools.map((tool) => tool.label)),
    tools: tools.map((tool) => tool.name),
    models: models.flatMap((row) => (row.model ? [row.model] : [])),
    prompts,
  });
}

/** Distinct slices of the newest system prompts the project's spans carry. */
async function recentPromptSlices(projectId: string): Promise<string[]> {
  const key = "gen_ai.system_instructions";
  const rows = await getDb()
    .select({ instructions: sql<unknown>`${otelSpans.attributes} -> ${key}` })
    .from(otelSpans)
    .where(
      and(
        eq(otelSpans.projectId, projectId),
        sql`${otelSpans.attributes} ? ${key}`,
        gt(otelSpans.startedAt, sql`now() - make_interval(days => ${MODEL_WINDOW_DAYS})`),
      ),
    )
    .orderBy(desc(otelSpans.startedAt))
    .limit(50);
  const slices = new Set<string>();
  for (const row of rows) {
    const text = systemFromInstructions(
      row.instructions as Parameters<typeof systemFromInstructions>[0],
    );
    const slice = text ? promptSlice(text) : null;
    if (slice) slices.add(slice);
    if (slices.size >= MAX_PROMPTS) break;
  }
  return [...slices];
}
