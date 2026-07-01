#!/usr/bin/env node
// Seed the Ratel Cloud backend with realistic agent events for dashboard demos.
//
// Ships a mix of event profiles engineered so the backend's categorizer
// (apps/cloud/lib/categorize.ts) attributes tokens across ALL FIVE context
// sources — skills / tools / history / memory / user_input. Timestamps follow a
// realistic traffic curve (diurnal + weekday/weekend + a growth trend + per-day
// noise and occasional spikes) rather than an even grid. A client-side preview
// mirrors that categorizer so you can verify the distribution before sending.
//
//   Endpoint : $RATEL_CLOUD_ENDPOINT   (default http://localhost:3000/api/v1/events)
//   API key  : $RATEL_CLOUD_API_KEY    (required)
//
// Usage:
//   RATEL_CLOUD_API_KEY=rtl_... node scripts/seed.mjs [count] [--days N] [--dry]
//     count      number of events to generate (default 90)
//     --days N   spread across the last N days (default 30)
//     --dry      preview the split + time range without sending
//
// Every event carries a unique nonce; the ingest endpoint deduplicates by a
// full-body hash, so re-running always ingests fresh rows rather than colliding.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_DIST_INDEX = resolve(HERE, "..", "ts", "dist", "index.js");
if (!existsSync(TS_DIST_INDEX)) {
  console.error(`TS client is not built (${TS_DIST_INDEX} missing). Run: pnpm --dir ${join(HERE, "..", "ts")} build`);
  process.exit(2);
}
const { sendEventBatch, validate } = await import(pathToFileURL(TS_DIST_INDEX).href);

const ENDPOINT = process.env.RATEL_CLOUD_ENDPOINT ?? "http://localhost:3000/api/v1/events";
const API_KEY = process.env.RATEL_CLOUD_API_KEY;
if (!API_KEY) {
  console.error("RATEL_CLOUD_API_KEY is required");
  process.exit(2);
}

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const daysIdx = argv.indexOf("--days");
const WINDOW_DAYS = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 30;
const COUNT = Number(argv.find((a) => /^\d+$/.test(a)) ?? 90);
const DAY = 86_400_000;
const WINDOW = WINDOW_DAYS * DAY;
const now = Date.now();
const START = now - WINDOW;

/* --------------------------------- rng ------------------------------------ */
const ri = (n) => Math.floor(Math.random() * n);
const choice = (arr) => arr[ri(arr.length)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = ri(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/* ---------------------- content building blocks --------------------------- */

const BASE_SYSTEM =
  "You are Atlas, an autonomous engineering assistant. Follow the user's " +
  "instructions carefully and prefer precise, verifiable answers. When you call a " +
  "tool, briefly say why. Never fabricate file paths, APIs, or citations. Keep " +
  "responses concise unless asked to elaborate.";

const SKILLS_BLOCK =
  "<skills>\n" +
  '<skill name="web_search">Search the web and cite primary sources.</skill>\n' +
  '<skill name="code_review">Review diffs for correctness, security, and style; ' +
  "rank findings by severity.</skill>\n" +
  '<skill name="sql">Author and explain SQL against the analytics warehouse.</skill>\n' +
  "</skills>";

const MEMORY_BLOCK =
  "<memory>\n" +
  "User prefers TypeScript over JavaScript and terse, imperative commit messages. " +
  "The 'ratel' project is a Rust core (ratel-ai-core) wrapped by TS/Python SDKs, " +
  "using pnpm + cargo workspaces. The user works on macOS. ADR-0013 fixed the cloud " +
  "telemetry schema: raw agent events, one unified shape, pure-language clients. " +
  "The user dislikes AI-attribution lines in commits.\n" +
  "</memory>";

const CONTEXT_BLOCK =
  "<retrieved_context>\n" +
  "[1] Vercel Edge and Cloudflare Workers expose a global fetch, so the client needs " +
  "no native addon. [2] httpx.AsyncClient reuses a connection pool across batches. " +
  "[3] The ingest endpoint deduplicates by a full-body hash and replies {accepted:n}. " +
  "[4] Batches are capped at MAX_BATCH=500 events per request.\n" +
  "</retrieved_context>";

const HISTORY_TURNS = [
  { role: "user", content: "Where does the batching transport live in the TS client?" },
  { role: "assistant", content: "In src/transport.ts — sendEventBatch POSTs with retry/backoff; client.ts owns the queue." },
  { role: "user", content: "And how are invalid events handled?" },
  { role: "assistant", content: "validate() drops them before enqueue and reports via onError; they never hit the wire." },
];

const QUESTIONS = [
  "Weather in Paris tomorrow?",
  "Summarize the open PRs touching the cloud client.",
  "How many events did we ingest yesterday, by provider?",
  "Draft a PR that adds a --dry flag to the seeder.",
  "Explain the dedup behavior of the ingest endpoint.",
  "What's the difference between skills and memory in the split?",
  "Find the slowest endpoint in the last 24h.",
  "Write a migration to add a category column.",
];

// A pool of tools; tool-using calls offer a random 5-10 and invoke a random 1-3.
const TOOL_POOL = [
  { name: "get_weather", description: "Look up current weather for a location.", parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] }, sample: () => ({ location: choice(["Paris", "Tokyo", "New York", "Berlin"]) }), result: "18°C, cloudy" },
  { name: "search_docs", description: "Full-text search the internal documentation corpus and return ranked snippets.", parameters: { type: "object", properties: { query: { type: "string" }, top_k: { type: "integer" } }, required: ["query"] }, sample: () => ({ query: choice(QUESTIONS), top_k: 5 }), result: "Top hit: src/cloud/README.md" },
  { name: "run_sql", description: "Execute a read-only SQL query against the analytics warehouse and return rows.", parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] }, sample: () => ({ sql: "select provider, count(*) from events group by 1" }), result: "openai 812; anthropic 640; google 173" },
  { name: "open_pr", description: "Open a pull request with a title, body, and branch.", parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, branch: { type: "string" } }, required: ["title", "branch"] }, sample: () => ({ title: "seed", branch: "seed/data" }), result: "opened #128" },
  { name: "list_files", description: "List files under a repository path, optionally filtered by glob.", parameters: { type: "object", properties: { path: { type: "string" }, glob: { type: "string" } }, required: ["path"] }, sample: () => ({ path: "src/cloud", glob: "**/*.ts" }), result: "12 files" },
  { name: "read_file", description: "Read the contents of a file at a given path.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, sample: () => ({ path: "src/cloud/ts/src/transport.ts" }), result: "…86 lines…" },
  { name: "web_search", description: "Search the public web and return the top results with URLs.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, sample: () => ({ query: "vercel edge fetch limits" }), result: "3 results" },
  { name: "send_email", description: "Send an email to a recipient with a subject and body.", parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject"] }, sample: () => ({ to: "team@ratel.ai", subject: "weekly telemetry" }), result: "sent" },
  { name: "create_calendar_event", description: "Create a calendar event with a title, start, and duration.", parameters: { type: "object", properties: { title: { type: "string" }, start: { type: "string" }, minutes: { type: "integer" } }, required: ["title", "start"] }, sample: () => ({ title: "telemetry review", start: "2026-07-02T15:00:00Z", minutes: 30 }), result: "created" },
  { name: "execute_python", description: "Run a short Python snippet in a sandbox and return stdout.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] }, sample: () => ({ code: "print(sum(range(10)))" }), result: "45" },
];

// Build a tool-using assistant turn: offer 5-10 tools, invoke 1-3 of them.
function buildToolTurn(seq) {
  const offered = shuffle(TOOL_POOL).slice(0, 5 + ri(6)); // 5..10 offered
  const used = offered.slice(0, 1 + ri(3)); // 1..3 invoked
  const blocks = [{ type: "text", text: "On it — let me use a couple of tools." }];
  const toolMsgs = [];
  used.forEach((t, j) => {
    const id = `call_${seq}_${j}`;
    blocks.push({ type: "tool_call", id, name: t.name, arguments: t.sample() });
    toolMsgs.push({ role: "tool", tool_call_id: id, content: t.result });
  });
  return { tools: offered.map(({ name, description, parameters }) => ({ name, description, parameters })), blocks, toolMsgs };
}

/* --------------------------- event profiles ------------------------------- */
// Weighted mix (simple chats most common) so aggregate tokens land across all
// five categories with a realistic shape.

const MODELS = [
  ["openai", "gpt-5.5"],
  ["anthropic", "claude-opus-4-8"],
  ["anthropic", "claude-haiku-4-5"],
  ["google", "gemini-3-pro"],
];

const PROFILES = [
  // Agentic: base + skills + memory, many tools (some used), long history, heavy cache.
  { tag: "agentic", weight: 20, build: (seq) => {
    const t = buildToolTurn(seq);
    return {
      system: `${BASE_SYSTEM}\n\n${SKILLS_BLOCK}\n\n${MEMORY_BLOCK}`,
      tools: t.tools,
      messages: [...HISTORY_TURNS, { role: "user", content: choice(QUESTIONS) }, { role: "assistant", content: t.blocks }, ...t.toolMsgs],
      cacheRatio: 0.7,
      finish_reason: "tool_call",
    };
  } },
  // RAG chat: base + retrieved context (memory), no tools, some history, moderate cache.
  { tag: "rag", weight: 20, build: () => ({
    system: `${BASE_SYSTEM}\n\n${CONTEXT_BLOCK}`,
    tools: [],
    messages: [HISTORY_TURNS[0], HISTORY_TURNS[1], { role: "user", content: choice(QUESTIONS) }, { role: "assistant", content: `Based on the retrieved context: ${choice(QUESTIONS)}` }],
    cacheRatio: 0.4,
    finish_reason: "stop",
  }) },
  // Tool-heavy: base + skills, many tools (some used), short history, light cache.
  { tag: "tools", weight: 20, build: (seq) => {
    const t = buildToolTurn(seq);
    return {
      system: `${BASE_SYSTEM}\n\n${SKILLS_BLOCK}`,
      tools: t.tools,
      messages: [{ role: "user", content: choice(QUESTIONS) }, { role: "assistant", content: t.blocks }, ...t.toolMsgs],
      cacheRatio: 0.1,
      finish_reason: "tool_call",
    };
  } },
  // Simple chat: minimal system (→ mostly skills residual + user_input), no tools, no cache.
  { tag: "simple", weight: 30, build: () => ({
    system: "You are a helpful assistant.",
    tools: [],
    messages: [{ role: "user", content: choice(QUESTIONS) }, { role: "assistant", content: `Sure — ${choice(QUESTIONS)}` }],
    cacheRatio: 0,
    finish_reason: "stop",
  }) },
  // Multimodal: base + memory, image in the user turn, some history.
  { tag: "multimodal", weight: 10, build: () => ({
    system: `${BASE_SYSTEM}\n\n${MEMORY_BLOCK}`,
    tools: [],
    messages: [HISTORY_TURNS[0], HISTORY_TURNS[1], { role: "user", content: [
      { type: "text", text: "Describe this architecture diagram." },
      { type: "image", source: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", media_type: "image/png" },
    ] }, { role: "assistant", content: "It shows a Rust core wrapped by two pure-language clients." }],
    cacheRatio: 0.5,
    finish_reason: "stop",
  }) },
];
const PROFILE_TOTAL = PROFILES.reduce((s, p) => s + p.weight, 0);
function pickProfile() {
  let r = Math.random() * PROFILE_TOTAL;
  for (const p of PROFILES) if ((r -= p.weight) < 0) return p;
  return PROFILES[PROFILES.length - 1];
}

/* --------------------- realistic arrival-time sampling -------------------- */
// Per-day volume multipliers: most days ordinary, some quiet, ~1-in-8 a spike.
const dayNoise = Array.from({ length: WINDOW_DAYS }, () =>
  0.3 + Math.random() * 1.0 + (Math.random() < 0.12 ? 1.5 + Math.random() * 1.5 : 0));

// Relative traffic intensity at a given instant (unnormalized, > 0).
function intensity(tMs) {
  const d = new Date(tMs);
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const weekday = dow === 0 || dow === 6 ? 0.35 : 1.0; // weekends quieter
  const diurnal = 0.12 + 0.88 * Math.exp(-((hour - 14) ** 2) / (2 * 3.5 ** 2)); // peak ~14:00 UTC
  const frac = (tMs - START) / WINDOW;
  const trend = 0.6 + 0.4 * frac; // gentle adoption growth over the window
  const di = Math.min(WINDOW_DAYS - 1, Math.floor(frac * WINDOW_DAYS));
  return weekday * diurnal * trend * dayNoise[di];
}

// Rejection-sample n arrival times from the intensity curve → irregular, clustered.
function sampleTimes(n) {
  const M = Math.max(...dayNoise); // sup of intensity (other factors ≤ 1)
  const out = [];
  for (let guard = 0; out.length < n && guard < n * 500; guard++) {
    const t = START + Math.random() * WINDOW;
    if (Math.random() < intensity(t) / M) out.push(t);
  }
  while (out.length < n) out.push(START + Math.random() * WINDOW); // safety fill
  return out.sort((a, b) => a - b);
}

/* ------- client-side mirror of categorize.ts (preview only) --------------- */
const CHARS_PER_TOKEN = 4, IMAGE_TOKEN_EST = 1000;
const estText = (s) => (s ? Math.ceil(s.length / CHARS_PER_TOKEN) : 0);
const estBlocks = (c) => typeof c === "string" ? estText(c) : c.reduce((n, b) =>
  n + (b.type === "text" ? estText(b.text) : b.type === "tool_call" ? estText(b.name) + estText(JSON.stringify(b.arguments)) : IMAGE_TOKEN_EST), 0);
const estMessage = (m) => m.role === "tool" ? estText(m.content) : estBlocks(m.content);
const estTool = (t) => estText(t.name) + estText(t.description) + estText(JSON.stringify(t.parameters));
const SKILL_PATTERNS = [/<(?:available_)?skills?>[\s\S]*?<\/(?:available_)?skills?>/gi, /<skill\b[\s\S]*?<\/skill>/gi, /^#{1,4}\s*(?:available\s+)?skills?\b[\s\S]*?(?=\n#{1,4}\s|\n{2,}(?=\S)|$)/gim];
const MEMORY_PATTERNS = [/<memor(?:y|ies)>[\s\S]*?<\/memor(?:y|ies)>/gi, /<(?:retrieved_)?context>[\s\S]*?<\/(?:retrieved_)?context>/gi, /^#{1,4}\s*(?:relevant\s+)?memor(?:y|ies)\b[\s\S]*?(?=\n#{1,4}\s|\n{2,}(?=\S)|$)/gim];
const matchedChars = (t, ps) => ps.reduce((n, re) => { for (const m of t.matchAll(re)) n += m[0].length; return n; }, 0);
function estSystem(system) {
  if (!system) return { skills: 0, memory: 0 };
  const memoryChars = Math.min(system.length, matchedChars(system, MEMORY_PATTERNS));
  const skillChars = Math.min(system.length - memoryChars, matchedChars(system, SKILL_PATTERNS));
  const residual = system.length - memoryChars - skillChars;
  return { skills: Math.ceil((skillChars + residual) / CHARS_PER_TOKEN), memory: Math.ceil(memoryChars / CHARS_PER_TOKEN) };
}
const ORDER = ["skills", "tools", "history", "memory", "user_input"];
function allocate(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map(Math.floor);
  let rem = total - out.reduce((a, b) => a + b, 0);
  const byFrac = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; rem > 0 && k < byFrac.length; k++, rem--) out[byFrac[k].i]++;
  return out;
}
function estTotalOf(ev) {
  const tools = (ev.tools ?? []).reduce((n, t) => n + estTool(t), 0);
  let lastUser = -1; ev.messages.forEach((m, i) => { if (m.role === "user") lastUser = i; });
  let user = 0, hist = 0; ev.messages.forEach((m, i) => { const sz = estMessage(m); if (i === lastUser) user += sz; else hist += sz; });
  const sys = estSystem(ev.system);
  return { skills: sys.skills, tools, history: hist, memory: sys.memory, user_input: user };
}
function categorizePreview(ev) {
  const est = estTotalOf(ev);
  const alloc = allocate(ORDER.map((k) => est[k]), ev.usage.input_tokens);
  const out = {}; ORDER.forEach((k, i) => (out[k] = alloc[i]));
  return out;
}

/* ------------------------------- generate --------------------------------- */

let seq = 0;
function makeEvent(tMs) {
  const profile = pickProfile();
  const p = profile.build(seq);
  const [provider, model] = choice(MODELS);
  const nonce = `${now}-${seq++}-${Math.random().toString(36).slice(2)}`;
  // Make each event unique (dedup is a full-body hash) without disturbing category text.
  const messages = p.messages.map((m) => ({ ...m }));
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser && typeof lastUser.content === "string") lastUser.content += ` [${nonce}]`;

  const est = estTotalOf({ ...p, messages });
  const inputTokens = Math.max(1, ORDER.reduce((s, k) => s + est[k], 0));
  const ev = {
    provider,
    model,
    ts: new Date(tMs).toISOString(),
    stream: Math.random() < 0.5,
    latency_ms: 300 + ri(2500),
    system: p.system,
    messages,
    params: { temperature: Number((0.2 + ri(5) * 0.15).toFixed(2)), top_p: 1.0, max_tokens: 1024 },
    usage: {
      input_tokens: inputTokens,
      output_tokens: 20 + ri(400),
      cached_tokens: Math.round(inputTokens * p.cacheRatio),
      reasoning_tokens: ri(3) * 40,
    },
    finish_reason: p.finish_reason,
  };
  if (p.tools.length) ev.tools = p.tools;
  return { ev, tag: profile.tag };
}

const built = sampleTimes(COUNT).map((tMs) => makeEvent(tMs));
const events = built.map((b) => b.ev);

// Sanity: everything must pass the client's own validator.
const bad = events.map((e, i) => [i, validate(e)]).filter(([, r]) => !r.ok);
if (bad.length) {
  console.error(`refusing to send — ${bad.length} events failed validation`);
  console.error(bad.slice(0, 3).map(([i, r]) => `#${i}: ${JSON.stringify(r.issues)}`).join("\n"));
  process.exit(1);
}

// Preview: aggregate the derived category tokens exactly as the backend will,
// plus a coarse per-day volume histogram so the traffic shape is visible.
const totals = { skills: 0, tools: 0, history: 0, memory: 0, user_input: 0 };
const byTag = {};
const perDay = new Array(WINDOW_DAYS).fill(0);
for (const { ev, tag } of built) {
  const c = categorizePreview(ev);
  byTag[tag] = (byTag[tag] ?? 0) + 1;
  for (const k of ORDER) totals[k] += c[k];
  const di = Math.min(WINDOW_DAYS - 1, Math.floor((new Date(ev.ts).getTime() - START) / DAY));
  perDay[di]++;
}
const grand = ORDER.reduce((s, k) => s + totals[k], 0);
const tsList = events.map((e) => e.ts).sort();
console.log(`Generated ${COUNT} events across profiles: ${Object.entries(byTag).map(([t, n]) => `${t}×${n}`).join(", ")}`);
console.log(`Time range: ${tsList[0]} → ${tsList[tsList.length - 1]} (${WINDOW_DAYS} days)`);
console.log("Predicted category split (tokens, matches backend categorize.ts):");
for (const k of ORDER) console.log(`  ${k.padEnd(11)} ${String(totals[k]).padStart(7)}  ${((100 * totals[k]) / grand).toFixed(1)}%`);
const peak = Math.max(1, ...perDay);
console.log(`Per-day volume (max ${peak}):`);
console.log(`  ${perDay.map((v) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.round((v / peak) * 7))]).join("")}`);

if (DRY) { console.log("\n--dry: not sending."); process.exit(0); }

/* -------------------------------- send ------------------------------------ */
let sent = 0, accepted = 0;
const CHUNK = 20;
for (let i = 0; i < events.length; i += CHUNK) {
  const batch = events.slice(i, i + CHUNK);
  const r = await sendEventBatch(batch, { endpoint: ENDPOINT, apiKey: API_KEY, onError: (e) => console.error("send error:", String(e)) });
  sent += batch.length; accepted += r.accepted;
  console.log(`  batch ${i / CHUNK + 1}: sent ${batch.length}, status ${r.status}, accepted ${r.accepted}`);
}
console.log(`\nDone → ${sent} sent, ${accepted} newly ingested → ${ENDPOINT}`);
