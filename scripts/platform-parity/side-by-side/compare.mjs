// Compare what side-by-side.sh collected from the two editions (temporary parity harness, RTL-45).
//
//   node compare.mjs <work dir>
//
// Every difference is one line. A line that matches a `natural` entry of
// expected-differences.json is a difference between the editions that is meant to be there, and
// is left out. Every other line is reported and makes the run fail. The `audit` entries only put
// the audit's item number beside a reported line; a reported line with no item is a difference
// the audit did not find.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const work = process.argv[2];
if (!work || !existsSync(work)) {
  console.error("usage: node compare.mjs <work dir>");
  process.exit(2);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(readFileSync(join(HERE, "..", "expected-differences.json"), "utf8"));
const read = (path) => (existsSync(join(work, path)) ? readFileSync(join(work, path), "utf8") : "");
const ids = JSON.parse(read("ids.json") || "{}");

// A flag under either edition's name: Cloud's key ("cloud-eval-gate"), its environment switch,
// this edition's switch (FF_EVAL_GATE), and the wordings listed in `flagWording`.
const FLAG_OF = new Map();
for (const [here, cloud] of Object.entries(expected.flags)) {
  for (const name of [here, cloud, cloud.replace(/^FF_/, "").toLowerCase().replaceAll("_", "-")]) FLAG_OF.set(name, here);
}
for (const [wording, here] of Object.entries(expected.flagWording ?? {})) FLAG_OF.set(wording, here);
const FLAG_NAMES = new RegExp([...FLAG_OF.keys()].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Text with what differs from one run to the next read as one: ids, ports, keys, the clock. */
function steady(text) {
  let out = text;
  for (const [name, value] of Object.entries(ids)) if (value) out = out.split(value).join(`<${name.replace(/^(cloud|oss)/, "").toLowerCase()}>`);
  return out
    .replace(UUID, "<uuid>")
    .replace(/localhost:\d+/g, "localhost:<port>")
    .replace(/\brtl_[A-Za-z0-9_-]+…?/g, "<key>")
    .replace(/\b(\d+|an?|a few)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?|d|days?|weeks?|months?)\s+ago\b/g, "<ago>")
    .replace(/\bjust now\b/g, "<ago>")
    .replace(/\bRatel Cloud\b/g, "<app>")
    .replace(/\bRatel\b/g, "<app>")
    .replace(/t_[0-9a-f]{10}\b/g, "<topic>")
    .replace(FLAG_NAMES, (name) => `<flag ${FLAG_OF.get(name)}>`);
}

/** Lines only on one side, as multisets. */
function onlyEach(cloudLines, ossLines) {
  const count = (lines) => {
    const map = new Map();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(cloudLines);
  const b = count(ossLines);
  const out = [];
  for (const [line, n] of a) for (let i = 0; i < n - (b.get(line) ?? 0); i++) out.push({ side: "cloud", line });
  for (const [line, n] of b) for (let i = 0; i < n - (a.get(line) ?? 0); i++) out.push({ side: "here", line });
  return out;
}

const findings = [];
function report(check, part, differences) {
  for (const { side, line } of differences) {
    const where = { check, part, side, line };
    const matches = (entry) =>
      (!entry.check || entry.check === check) &&
      (!entry.part || new RegExp(entry.part).test(part)) &&
      (!entry.side || entry.side === side) &&
      new RegExp(entry.pattern).test(line);
    if (expected.natural.some(matches)) continue;
    const known = expected.audit.find(matches);
    findings.push({ ...where, item: known?.item ?? null, what: known?.what ?? null });
  }
}

// ── schema facts ──────────────────────────────────────────────────────────────────────────
const lines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
report("schema", "facts", onlyEach(lines(read("schema/cloud.txt")), lines(read("schema/oss.txt"))));

// ── what the seed stored, before anything ran ─────────────────────────────────────────────
report("seed", "trace_events by type", onlyEach(lines(read("seed/cloud.txt")), lines(read("seed/oss.txt"))));

// ── row by row ────────────────────────────────────────────────────────────────────────────
const WALL = new Set(expected.rows.ignoredColumns);
const wallPatterns = (expected.rows.ignoredColumnPatterns ?? []).map((pattern) => new RegExp(pattern));
const walled = (column) => WALL.has(column) || wallPatterns.some((pattern) => pattern.test(column));
const sorted = (value) =>
  Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
const rowText = (row) => steady(JSON.stringify(sorted(Object.fromEntries(Object.entries(row).filter(([key]) => !walled(key))))));
for (const table of expected.rows.tables) {
  const cloudRows = JSON.parse(read(`rows/cloud-${table}.json`) || "[]");
  const ossRows = JSON.parse(read(`rows/oss-${table}.json`) || "[]");
  const diff = onlyEach(cloudRows.map(rowText), ossRows.map(rowText));
  const only = (side) => diff.filter((d) => d.side === side).length;
  if (diff.length > 0) {
    // Which columns carry the difference: each column's values compared as a multiset.
    const columns = Object.keys(cloudRows[0] ?? ossRows[0] ?? {}).filter((column) => !walled(column));
    const values = (rows, column) => JSON.stringify(rows.map((row) => steady(JSON.stringify(sorted(row[column])))).sort());
    const differing = columns.filter((column) => values(cloudRows, column) !== values(ossRows, column));
    report("rows", table, [
      {
        side: "both",
        line: `${table}: Cloud ${cloudRows.length} rows, here ${ossRows.length}; ${only("cloud")} only on Cloud, ${only("here")} only here; columns that differ: ${differing.join(", ") || "none alone"}`,
      },
    ]);
    writeFileSync(join(work, `rows/diff-${table}.txt`), diff.map((d) => `${d.side}\t${d.line}`).join("\n"));
  }
}

// ── MCP ───────────────────────────────────────────────────────────────────────────────────
/** A JSON document as `path = value` lines; a list of named things is keyed by name, not by position. */
function flatten(value, path, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const key = item && typeof item === "object" ? (item.title ?? item.label ?? item.name ?? item.headline ?? null) : null;
      flatten(item, `${path}[${typeof key === "string" ? key : index}]`, out);
    });
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) flatten(value[key], path ? `${path}.${key}` : key, out);
  } else out.push(`${path} = ${JSON.stringify(value)}`);
  return out;
}
/** A tool call's answer: the JSON its text content carries, else the result itself. */
function mcpAnswer(text) {
  if (!text.trim()) return { missing: true };
  const body = text.includes("\ndata: ") || text.startsWith("event:") ? text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) : text;
  const parsed = JSON.parse(body ?? "{}");
  const content = parsed.result?.content?.[0]?.text;
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return { text: content };
    }
  }
  return parsed.result ?? parsed;
}
for (const state of ["flags-off", "flags-on"]) {
  for (const name of expected.mcp.calls) {
    const cloudDoc = mcpAnswer(read(`mcp/cloud-${state}-${name}.json`));
    const ossDoc = mcpAnswer(read(`mcp/oss-${state}-${name}.json`));
    const flat = (doc) => flatten(doc, "", []).map(steady).filter((line) => !expected.mcp.ignoredPaths.some((pattern) => new RegExp(pattern).test(line)));
    report("mcp", `${name} (${state})`, onlyEach(flat(cloudDoc), flat(ossDoc)));
  }
}

// ── pages ─────────────────────────────────────────────────────────────────────────────────
const pageFiles = existsSync(join(work, "pages")) ? readdirSync(join(work, "pages")) : [];
for (const file of pageFiles.filter((name) => name.startsWith("cloud-")).sort()) {
  const part = file.replace(/^cloud-/, "").replace(/\.txt$/, "");
  const text = (edition) => lines(steady(read(`pages/${edition}-${part}.txt`)));
  report("pages", part, onlyEach(text("cloud"), text("oss")));
}

// ── the report ────────────────────────────────────────────────────────────────────────────
const byItem = new Map();
for (const finding of findings) {
  const key = finding.item === null ? "none" : String(finding.item);
  byItem.set(key, [...(byItem.get(key) ?? []), finding]);
}
const out = [];
const short = (line) => (line.length > 150 ? `${line.slice(0, 147)}…` : line);
for (const key of [...byItem.keys()].filter((k) => k !== "none").sort((a, b) => Number(a) - Number(b))) {
  const group = byItem.get(key);
  out.push(`\naudit item ${key}: ${group[0].what} (${group.length} line${group.length === 1 ? "" : "s"})`);
  const fixes = new Set(group.filter((f) => f.check === "mcp").map((f) => f.line.match(/^data\.fixes\[(.*?)\]\.effect/)?.[1]).filter(Boolean));
  if (fixes.size > 0) {
    const total = mcpAnswer(read("mcp/cloud-flags-on-list_fixes.json")).data?.fixes?.length ?? "?";
    out.push(`  list_fixes: effect differs on ${fixes.size} of ${total} fixes`);
  }
  const parts = new Map();
  for (const f of group) parts.set(`${f.check} › ${f.part}`, [...(parts.get(`${f.check} › ${f.part}`) ?? []), f]);
  for (const [part, list] of parts) {
    out.push(`  ${part}`);
    for (const f of list.slice(0, 4)) out.push(`    [${f.side}] ${short(f.line)}`);
    if (list.length > 4) out.push(`    … and ${list.length - 4} more`);
  }
}
const unexplained = byItem.get("none") ?? [];
if (unexplained.length > 0) {
  out.push(`\nNOT IN THE AUDIT (${unexplained.length} line${unexplained.length === 1 ? "" : "s"})`);
  for (const f of unexplained.slice(0, 60)) out.push(`  ${f.check} › ${f.part} [${f.side}] ${short(f.line)}`);
  if (unexplained.length > 60) out.push(`  … and ${unexplained.length - 60} more`);
}
const items = [...byItem.keys()].filter((k) => k !== "none").sort((a, b) => Number(a) - Number(b));
out.unshift(
  findings.length === 0
    ? "side by side: the two editions differ only where expected-differences.json says they may."
    : `side by side: ${findings.length} difference line${findings.length === 1 ? "" : "s"} beyond the natural ones; audit items ${items.join(", ") || "none"}; ${unexplained.length} outside the audit.`,
);
writeFileSync(join(work, "report.txt"), `${out.join("\n")}\n`);
writeFileSync(join(work, "findings.json"), JSON.stringify(findings, null, 1));
console.log(out.join("\n"));
process.exit(findings.length === 0 ? 0 : 1);
