import type { CloudEvent, CloudMessage, CloudToolDef } from "@/lib/ingest/cloud-schema";
import type { ContextSource } from "@/lib/ingest/context";
import { INVOKE_TOOL_ID, innerToolId } from "@/lib/ingest/gateway-tools";

/**
 * Derive the dashboard's context categories from a raw ADR-0013 agent event. The
 * SDK no longer sends a pre-computed split; it sends the raw call, and we
 * attribute its input tokens across the five sources here.
 *
 * Two kinds of signal:
 * - **Exact**, from structure: which tools were actually called (`tool_call`
 *   blocks) → used vs unused; which prompt tokens were cache-read
 *   (`usage.cached_tokens`) → history cached vs uncached.
 * - **Heuristic**, from text: skills / memory are regex-extracted from the system
 *   prompt (agents inject them there), and every segment's *size* is estimated by
 *   a chars≈tokens ratio, then rescaled so the parts sum to the real
 *   `usage.input_tokens` (the same proportional trick `dashboard.ts` uses for
 *   cost/latency). Because the split is heuristic, this whole function is
 *   **versioned** — bump {@link CATEGORIZER_VERSION} and re-run the backfill to
 *   restate history when the rules improve.
 */

/**
 * Bump when the derivation rules change; the backfill restates rows below this.
 *
 * v3: distinct tools counted by name (a tool defined twice counts once), and an
 * event whose segments all estimate to zero but that reports real input tokens
 * attributes them to the current turn instead of dropping them.
 *
 * v4: Ratel-gateway `invoke_tool` calls are unwrapped to the inner tool they ran
 * (the real id lives in the call arguments), so the Tools tab attributes usage to
 * the actual tool instead of the gateway wrapper. Re-run the backfill after
 * deploying to restate existing gateway events.
 */
export const CATEGORIZER_VERSION = 4;

/** Rough bytes→tokens ratio for size *estimation* only (real totals come from usage). */
const CHARS_PER_TOKEN = 4;
/** Flat nominal token cost for an image/file block — base64 length wildly overstates it. */
const IMAGE_TOKEN_EST = 1000;

export type CategorySplits = {
  history_cached: number;
  history_uncached: number;
  tools_used: number;
  tools_unused: number;
};

/** Per-tool footprint for one event: how often it was called and its token size. */
export type ToolStat = { calls: number; tokens: number };

/** Every tool this event offered (or called), keyed by tool name. */
export type ToolsByName = Record<string, ToolStat>;

export type EventMetrics = {
  /** Input tokens attributed to each source; sums to `usage.input_tokens`. */
  tokensByCategory: Record<ContextSource, number>;
  /** The two sub-splits: history cached/uncached and tools used/unused. */
  splits: CategorySplits;
  /** Per-tool calls + token footprint, keyed by tool name. */
  toolsByName: ToolsByName;
  /** Total tool definitions offered this call. */
  toolsTotalCount: number;
  /** How many of them the model actually called. */
  toolsUsedCount: number;
  categorizerVersion: number;
};

const estText = (s: string | null | undefined): number =>
  s ? Math.ceil(s.length / CHARS_PER_TOKEN) : 0;

function estBlocks(content: Extract<CloudMessage, { role: "user" }>["content"]): number {
  if (typeof content === "string") return estText(content);
  let n = 0;
  for (const b of content) {
    if (b.type === "text") n += estText(b.text);
    else if (b.type === "tool_call") n += estText(b.name) + estText(JSON.stringify(b.arguments));
    else n += IMAGE_TOKEN_EST; // image | file
  }
  return n;
}

function estMessage(m: CloudMessage): number {
  return m.role === "tool" ? estText(m.content) : estBlocks(m.content);
}

function estTool(t: CloudToolDef): number {
  return estText(t.name) + estText(t.description) + estText(JSON.stringify(t.parameters));
}

/** How many times each tool was invoked, from assistant `tool_call` blocks. */
function toolCallCounts(messages: CloudMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_call") counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * How many times each *inner* tool ran through the Ratel gateway. The model names
 * the wrapper (`invoke_tool`) in the call; the real tool id rides in the call's
 * `arguments` (`{ toolId, args }`). Unwrap those so the Tools tab can attribute
 * usage to the tool that actually ran. Direct (non-gateway) agents emit no
 * `invoke_tool` calls, so this is empty and nothing changes for them.
 */
function innerToolCallCounts(messages: CloudMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_call" || b.name !== INVOKE_TOOL_ID) continue;
      const inner = innerToolId(b.arguments);
      if (inner) counts.set(inner, (counts.get(inner) ?? 0) + 1);
    }
  }
  return counts;
}

/* ------------------------- system-prompt extraction ------------------------ */

/** Skill blocks agents inject into the system prompt (Claude-Code-style + tagged). */
const SKILL_PATTERNS: RegExp[] = [
  /<(?:available_)?skills?>[\s\S]*?<\/(?:available_)?skills?>/gi,
  /<skill\b[\s\S]*?<\/skill>/gi,
  /^#{1,4}\s*(?:available\s+)?skills?\b[\s\S]*?(?=\n#{1,4}\s|\n{2,}(?=\S)|$)/gim,
];

/** Retrieved-memory / RAG context injected into the system prompt. */
const MEMORY_PATTERNS: RegExp[] = [
  /<memor(?:y|ies)>[\s\S]*?<\/memor(?:y|ies)>/gi,
  /<(?:retrieved_)?context>[\s\S]*?<\/(?:retrieved_)?context>/gi,
  /^#{1,4}\s*(?:relevant\s+)?memor(?:y|ies)\b[\s\S]*?(?=\n#{1,4}\s|\n{2,}(?=\S)|$)/gim,
];

function matchedChars(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const re of patterns) for (const m of text.matchAll(re)) n += m[0].length;
  return n;
}

/**
 * Attribute the system prompt to sources. Detected skill / memory spans go to
 * their source; the **residual** base instructions fold into `skills` — they're
 * the always-loaded instruction overhead ("loaded whether or not they're used").
 * Char counts (clamped so extraction can't exceed the prompt) → estimated tokens.
 */
function estSystem(system: string | null | undefined): { skills: number; memory: number } {
  if (!system) return { skills: 0, memory: 0 };
  const memoryChars = Math.min(system.length, matchedChars(system, MEMORY_PATTERNS));
  const skillChars = Math.min(system.length - memoryChars, matchedChars(system, SKILL_PATTERNS));
  const residual = system.length - memoryChars - skillChars;
  return {
    skills: Math.ceil((skillChars + residual) / CHARS_PER_TOKEN),
    memory: Math.ceil(memoryChars / CHARS_PER_TOKEN),
  };
}

/* ------------------------------- allocation ------------------------------- */

/**
 * Split `total` (an integer) across `weights` proportionally, rounding by largest
 * remainder so the parts sum to exactly `total`. Returns all-zero when there's no
 * weight or nothing to allocate.
 */
function allocate(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map(Math.floor);
  let remainder = total - out.reduce((a, b) => a + b, 0);
  const byFrac = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0 && k < byFrac.length; k++, remainder--) out[byFrac[k].i]++;
  return out;
}

const SOURCE_ORDER: ContextSource[] = ["skills", "tools", "history", "memory", "user_input"];

export function categorize(event: CloudEvent): EventMetrics {
  const messages = event.messages;

  // Tools: used vs unused by whether the model called them. Count by *distinct
  // name* (a tool defined twice shouldn't inflate the "N of M tools" counts).
  const callCounts = toolCallCounts(messages);
  const tools = event.tools ?? [];
  const toolSizes = tools.map(estTool);
  let toolsUsedEst = 0;
  let toolsUnusedEst = 0;
  const definedNames = new Set<string>();
  const usedNames = new Set<string>();
  for (let i = 0; i < tools.length; i++) {
    const sz = toolSizes[i];
    const name = tools[i].name;
    definedNames.add(name);
    if (callCounts.has(name)) {
      toolsUsedEst += sz;
      usedNames.add(name);
    } else {
      toolsUnusedEst += sz;
    }
  }

  // Messages: the last user turn is the current input; everything else is history.
  let lastUserIdx = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") lastUserIdx = i;
  });
  let userInputEst = 0;
  let historyEst = 0;
  messages.forEach((m, i) => {
    const sz = estMessage(m);
    if (i === lastUserIdx) userInputEst += sz;
    else historyEst += sz;
  });

  const sys = estSystem(event.system);

  // Estimated size per source, then rescale to the real input-token total.
  const est: Record<ContextSource, number> = {
    skills: sys.skills,
    tools: toolsUsedEst + toolsUnusedEst,
    history: historyEst,
    memory: sys.memory,
    user_input: userInputEst,
  };
  const estTotal = SOURCE_ORDER.reduce((s, k) => s + est[k], 0);
  const budget = event.usage?.input_tokens ?? estTotal;

  // When every segment estimates to zero (e.g. empty message content) but the model
  // still reports input tokens, attribute them all to the current turn so the parts
  // still reconcile to input_tokens instead of silently vanishing.
  if (estTotal === 0 && budget > 0) est.user_input = budget;

  const allocated = allocate(
    SOURCE_ORDER.map((k) => est[k]),
    budget,
  );
  const tokensByCategory = {} as Record<ContextSource, number>;
  // biome-ignore lint/suspicious/useIterableCallbackReturn: synced from upstream as is
  SOURCE_ORDER.forEach((k, i) => (tokensByCategory[k] = allocated[i]));

  // Allocate the (rounded) tools total across the individual tool defs by their
  // estimated size, so per-tool token footprints sum exactly to the source total.
  const toolTokens = allocate(toolSizes, tokensByCategory.tools);
  const toolsByName: ToolsByName = {};
  tools.forEach((t, i) => {
    const e = toolsByName[t.name] ?? { calls: callCounts.get(t.name) ?? 0, tokens: 0 };
    e.tokens += toolTokens[i]; // sum duplicate defs sharing a name
    toolsByName[t.name] = e;
  });
  // Tools called but not defined this event (defined elsewhere) still count as used.
  for (const [name, calls] of callCounts) {
    if (!toolsByName[name]) toolsByName[name] = { calls, tokens: 0 };
  }

  // Ratel gateway: surface the tools the agent actually ran via `invoke_tool` (the
  // inner tool id lives in the call's arguments, not the call name). They carry no
  // prompt tokens — the gateway ships only its own meta-tool defs, never the inner
  // tool's schema, which is the whole point — so they add call counts with a zero
  // footprint and don't perturb the used/unused token split. The `invoke_tool`
  // wrapper itself stays in the map as its real def overhead; the Tools tab hides
  // the gateway meta-tools by default.
  for (const [name, calls] of innerToolCallCounts(messages)) {
    const e = toolsByName[name] ?? { calls: 0, tokens: 0 };
    e.calls += calls;
    toolsByName[name] = e;
  }

  // Derive the used/unused token split straight from the per-tool allocation, so
  // the aggregate split and the per-tool rows never disagree.
  let tools_used = 0;
  let tools_unused = 0;
  tools.forEach((t, i) => {
    if (callCounts.has(t.name)) tools_used += toolTokens[i];
    else tools_unused += toolTokens[i];
  });

  // History cached/uncached: cache covers the stable prefix (skills + memory +
  // tools) first; whatever cached tokens remain spill into the older history.
  const cached = Math.min(event.usage?.cached_tokens ?? 0, budget);
  const prefix = tokensByCategory.skills + tokensByCategory.memory + tokensByCategory.tools;
  const history_cached = Math.max(0, Math.min(tokensByCategory.history, cached - prefix));
  const history_uncached = tokensByCategory.history - history_cached;

  return {
    tokensByCategory,
    splits: { history_cached, history_uncached, tools_used, tools_unused },
    toolsByName,
    toolsTotalCount: definedNames.size,
    toolsUsedCount: usedNames.size,
    categorizerVersion: CATEGORIZER_VERSION,
  };
}
