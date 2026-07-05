import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

interface BaseEvent {
  type: string;
  ts: number;
  session_id: string;
}

export interface InspectOptions {
  from?: string;
  /** Restrict the summary to the most recent N events. */
  last?: number;
  /** Override the telemetry root. Default `$RATEL_TELEMETRY_DIR` or `~/.ratel/telemetry`. */
  dir?: string;
  /** Absolute project path; selects the bucket. Defaults to `process.cwd()`. */
  project?: string;
  /** Scan every bucket under the root, picking the global newest by mtime. */
  all?: boolean;
}

export interface ListOptions {
  project?: string;
  all?: boolean;
}

/** Telemetry root. Per-project buckets nest under this. */
export function defaultTelemetryDir(): string {
  return process.env.RATEL_TELEMETRY_DIR ?? join(homedir(), ".ratel", "telemetry");
}

/** Mirror of Claude Code's `~/.claude/projects/<slug>/` rule: every `/` and `.` becomes `-`. */
export function slugifyProjectPath(absPath: string): string {
  return absPath.replace(/[/.]/g, "-");
}

export function projectBucketDir(root: string, absPath: string): string {
  return join(root, slugifyProjectPath(absPath));
}

export async function listSessions(
  dir: string = defaultTelemetryDir(),
  opts: ListOptions = {},
): Promise<string> {
  if (opts.all) {
    const rows = await collectAcrossBuckets(dir);
    if (rows.length === 0) return `no telemetry under ${dir}`;
    rows.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const header = `${pad("project", 36)}  ${pad("file", 56)}  ${pad("size", 10, "right")}  modified`;
    const body = rows
      .map(
        (r) =>
          `${pad(r.slug, 36)}  ${pad(r.name, 56)}  ${pad(formatSize(r.size), 10, "right")}  ${r.mtime.toISOString()}`,
      )
      .join("\n");
    return `${header}\n${body}`;
  }

  const project = opts.project ?? process.cwd();
  const bucket = projectBucketDir(dir, project);
  let entries: string[];
  try {
    entries = await readdir(bucket);
  } catch {
    return `no telemetry for this project (${bucket})`;
  }
  const files = entries.filter((e) => e.endsWith(".jsonl"));
  if (files.length === 0) return `no telemetry for this project (${bucket})`;
  const rows: Array<{ name: string; size: number; mtime: Date }> = [];
  for (const f of files) {
    const s = await stat(join(bucket, f));
    rows.push({ name: f, size: s.size, mtime: s.mtime });
  }
  rows.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const header = `${pad("file", 56)}  ${pad("size", 10, "right")}  modified`;
  const body = rows
    .map(
      (r) =>
        `${pad(r.name, 56)}  ${pad(formatSize(r.size), 10, "right")}  ${r.mtime.toISOString()}`,
    )
    .join("\n");
  return `${header}\n${body}`;
}

export async function summarizeSession(opts: InspectOptions = {}): Promise<string> {
  const dir = opts.dir ?? defaultTelemetryDir();

  let file: string | undefined;
  let emptyMessage: string;
  if (opts.from) {
    file = opts.from;
    emptyMessage = `${opts.from}: no events`;
  } else if (opts.all) {
    file = await mostRecentAcrossBuckets(dir);
    emptyMessage = `no telemetry under ${dir}`;
  } else {
    const project = opts.project ?? process.cwd();
    const bucket = projectBucketDir(dir, project);
    file = await mostRecent(bucket);
    emptyMessage = `no telemetry for this project (${bucket})`;
  }
  if (!file) return emptyMessage;

  const events = await readEvents(file, opts.last);
  if (events.length === 0) return `${file}: no events`;

  return [
    `session ${describeSession(events)}`,
    `file:    ${file}`,
    "",
    sessionTotals(events),
    "",
    topToolsByHit(events),
    "",
    gatewayVsDirect(events),
    "",
    topErrors(events),
  ].join("\n");
}

async function mostRecent(dir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  const files = entries.filter((e) => e.endsWith(".jsonl"));
  if (files.length === 0) return undefined;
  const rows: Array<{ path: string; mtime: number }> = [];
  for (const f of files) {
    const s = await stat(join(dir, f));
    rows.push({ path: join(dir, f), mtime: s.mtime.getTime() });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows[0].path;
}

async function mostRecentAcrossBuckets(root: string): Promise<string | undefined> {
  const rows = await collectAcrossBuckets(root);
  if (rows.length === 0) return undefined;
  rows.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return rows[0].path;
}

interface BucketRow {
  slug: string;
  name: string;
  path: string;
  size: number;
  mtime: Date;
}

async function collectAcrossBuckets(root: string): Promise<BucketRow[]> {
  let buckets: string[];
  try {
    buckets = await readdir(root);
  } catch {
    return [];
  }
  const rows: BucketRow[] = [];
  for (const slug of buckets) {
    const bucket = join(root, slug);
    let bucketStat: Awaited<ReturnType<typeof stat>>;
    try {
      bucketStat = await stat(bucket);
    } catch {
      continue;
    }
    if (!bucketStat.isDirectory()) continue;
    let entries: string[];
    try {
      entries = await readdir(bucket);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = join(bucket, name);
      const fileStat = await stat(filePath);
      rows.push({
        slug,
        name,
        path: filePath,
        size: fileStat.size,
        mtime: fileStat.mtime,
      });
    }
  }
  return rows;
}

async function readEvents(file: string, last?: number): Promise<BaseEvent[]> {
  const out: BaseEvent[] = [];
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as BaseEvent;
      out.push(parsed);
    } catch {
      // skip malformed lines — query-log semantics tolerate corruption
    }
  }
  if (typeof last === "number" && out.length > last) {
    return out.slice(out.length - last);
  }
  return out;
}

function describeSession(events: BaseEvent[]): string {
  const sids = new Set(events.map((e) => e.session_id));
  if (sids.size === 1) return events[0].session_id;
  return `${sids.size} session(s)`;
}

function sessionTotals(events: BaseEvent[]): string {
  const totals: Record<string, number> = {
    total: events.length,
    search: 0,
    invoke: 0,
    gateway: 0,
    upstream: 0,
    auth: 0,
    error: 0,
  };
  for (const e of events) {
    if (e.type === "search") totals.search++;
    else if (e.type.startsWith("invoke")) totals.invoke++;
    else if (e.type.startsWith("gateway")) totals.gateway++;
    else if (e.type.startsWith("upstream")) totals.upstream++;
    else if (e.type.startsWith("auth")) totals.auth++;
    if (e.type.endsWith("_error") || e.type === "gateway_error" || e.type === "upstream_error") {
      totals.error++;
    }
  }
  const wallMs = events.length > 0 ? events[events.length - 1].ts - events[0].ts : 0;
  const rows: Array<[string, string]> = [
    ["events", String(totals.total)],
    ["search", String(totals.search)],
    ["invoke", String(totals.invoke)],
    ["gateway", String(totals.gateway)],
    ["upstream", String(totals.upstream)],
    ["auth", String(totals.auth)],
    ["errors", String(totals.error)],
    ["wall ms", String(wallMs)],
  ];
  return formatTable(["totals", "value"], rows);
}

function topToolsByHit(events: BaseEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    const ev = e as BaseEvent & { hits?: Array<{ tool_id: string }> };
    if (ev.type === "search" && Array.isArray(ev.hits)) {
      for (const h of ev.hits) counts.set(h.tool_id, (counts.get(h.tool_id) ?? 0) + 1);
    }
  }
  const rows = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, n]) => [id, String(n)] as [string, string]);
  if (rows.length === 0) rows.push(["—", "0"]);
  return formatTable(["top tools by hit", "count"], rows);
}

function gatewayVsDirect(events: BaseEvent[]): string {
  let gw = 0;
  let direct = 0;
  for (const e of events) {
    if (e.type === "gateway_invoke") gw++;
    else if (e.type === "invoke_end") direct++;
  }
  // direct includes both the gateway-routed invokes AND any other invokes; subtract gw to get the truly-direct count.
  const trulyDirect = Math.max(0, direct - gw);
  return formatTable(
    ["invoke source", "count"],
    [
      ["gateway (search → invoke_tool)", String(gw)],
      ["direct (catalog.invoke)", String(trulyDirect)],
    ],
  );
}

function topErrors(events: BaseEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    const ev = e as BaseEvent & { error?: string };
    if (
      (e.type === "invoke_error" || e.type === "gateway_error" || e.type === "upstream_error") &&
      typeof ev.error === "string"
    ) {
      counts.set(ev.error, (counts.get(ev.error) ?? 0) + 1);
    }
  }
  const rows = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([m, n]) => [truncate(m, 80), String(n)] as [string, string]);
  if (rows.length === 0) rows.push(["—", "0"]);
  return formatTable(["top errors", "count"], rows);
}

function formatTable(header: [string, string], rows: Array<[string, string]>): string {
  const left = Math.max(header[0].length, ...rows.map((r) => r[0].length));
  const right = Math.max(header[1].length, ...rows.map((r) => r[1].length));
  const sep = `${"-".repeat(left)}  ${"-".repeat(right)}`;
  const head = `${pad(header[0], left)}  ${pad(header[1], right, "right")}`;
  const body = rows.map((r) => `${pad(r[0], left)}  ${pad(r[1], right, "right")}`).join("\n");
  return `${head}\n${sep}\n${body}`;
}

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return align === "right" ? `${fill}${s}` : `${s}${fill}`;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
