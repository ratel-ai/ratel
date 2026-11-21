import type { Manifest, ManifestParam } from "../manifest.js";
import { defaultMode } from "../tools.js";
import type { ToolMode } from "./args.js";

/** The manifest as a readable table: one block per twin, one row per param. */
export function formatManifest(manifest: Manifest): string {
  if (manifest.twins.length === 0) return "No twins found (looked for **/*.twin.*).\n";
  const lines: string[] = [];
  for (const twin of manifest.twins) {
    lines.push(`${twin.id}  ${twin.file ?? ""}  (${twin.input.kind} input)`);
    const rows = twin.params.map((p) => [p.name, typeOf(p), defaultOf(p), constraintsOf(p)]);
    lines.push(...table(rows).map((row) => `  ${row}`));
    lines.push("");
  }
  const providers = manifest.providers
    .map((p) => `${p.provider} (${p.keys.join(", ")})`)
    .join(", ");
  lines.push(`providers  ${providers || "(none)"}`);
  return `${lines.join("\n")}\n`;
}

export interface RunSummary {
  readonly twinId: string;
  readonly output: unknown;
  readonly overrides: readonly string[];
  /** The mode each tool ran in. */
  readonly tools: Readonly<Record<string, ToolMode>>;
  readonly configHash: string;
}

/** The output of one run, then the changed params and the config hash. */
export function formatRun(run: RunSummary): string {
  const tools = Object.entries(run.tools).map(([t, m]) => `${t}=${m}`);
  const rows = [
    ["twin", run.twinId],
    ["changed", run.overrides.join(", ") || "(none)"],
    ...(tools.length > 0 ? [["tool modes", tools.join(", ")]] : []),
    ["config hash", run.configHash],
  ];
  return `${JSON.stringify(run.output, null, 2)}\n\n${table(rows).join("\n")}\n`;
}

function typeOf(p: ManifestParam): string {
  return p.kind === "scalar" ? p.type : p.kind;
}

function constraintsOf(p: ManifestParam): string {
  if (p.kind !== "scalar") return "";
  if (p.type === "int" || p.type === "number") {
    if (p.min === undefined && p.max === undefined) return "";
    return `${p.min ?? ""}..${p.max ?? ""}`;
  }
  if (p.type === "enum") return p.values.join(" | ");
  if (p.type === "string" && p.maxLength !== undefined) return `max ${p.maxLength} chars`;
  return "";
}

/** A tools param lists each tool with its default mode: "searchDocs real, createTicket fake". */
function defaultOf(p: ManifestParam): string {
  if (p.kind !== "tools") return show(p.default);
  return p.default.map((tool) => `${tool.name} ${defaultMode(tool)}`).join(", ");
}

function show(value: unknown): string {
  const text =
    typeof value === "string" && !value.includes("/") ? JSON.stringify(value) : String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows.reduce<number[]>(
    (w, row) => row.map((cell, i) => Math.max(w[i] ?? 0, cell.length)),
    [],
  );
  return rows.map((row) =>
    row
      .map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i] ?? 0) : cell))
      .join("  ")
      .trimEnd(),
  );
}
