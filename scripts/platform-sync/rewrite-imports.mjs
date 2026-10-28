// Codemod for the platform sync (ADR-0030). Pure: `rewriteSource` takes source text and the
// rules and returns the rewritten text plus what it could not map. Three passes:
//
//   1. partitions — a named import from a hub module (`@/lib/db/schema`, `@/lib/db/queries`) is
//      split per symbol into one import per destination module; symbols no partition names go
//      to the hub's `default` destination and are reported as unmapped;
//   2. specifiers — every other import specifier is rewritten by the longest matching rule:
//      explicit rules from `rewrites.json`, then every `apps/web/lib/<from> -> apps/web/lib/<to>`
//      pair in `map.json`;
//   3. identifiers — whole-word renames (`clerkId` -> `externalId`), so the open-source tree
//      never carries a vendor name in a column or a field.

import { IMPORT_RE } from "../check-ee-boundary.mjs";
import { LAYERS } from "../check-layers.mjs";

const LIB = "apps/web/lib/";

/** Specifier rules in matching order: explicit rules from rewrites.json, then the map's lib moves. */
export function buildRules(map, rewrites) {
  const explicit = (rewrites?.rules ?? []).map((r) => ({ ...r, except: r.except ?? [] }));
  const hubs = new Set(Object.keys(rewrites?.partitions ?? {}));
  const derived = [];
  for (const entry of map.entries ?? []) {
    if (entry.mode === "excluded" || !entry.to) continue;
    if (!entry.from.startsWith(LIB) || !entry.to.startsWith(LIB)) continue;
    const from = `@/lib/${entry.from.slice(LIB.length)}`.replace(/\.tsx?$/, "");
    const to = `@/lib/${entry.to.slice(LIB.length)}`.replace(/\.tsx?$/, "");
    // A partitioned hub is split per symbol, never redirected whole.
    if (from === to || hubs.has(from)) continue;
    derived.push({ from, to, except: [], exact: /\.tsx?$/.test(entry.from) });
  }
  return [...explicit, ...derived].sort((a, b) => b.from.length - a.from.length);
}

function applyRules(specifier, rules) {
  for (const rule of rules) {
    if (rule.except.some((e) => specifier === e || specifier.startsWith(`${e}/`))) continue;
    if (rule.exact) {
      if (specifier === rule.from) return rule.to;
      continue;
    }
    if (specifier === rule.from) return rule.to;
    if (specifier.startsWith(rule.from.endsWith("/") ? rule.from : `${rule.from}/`)) {
      return rule.to + specifier.slice(rule.from.length);
    }
  }
  return null;
}

const isLayered = (specifier) => {
  const rest = specifier.slice("@/lib/".length);
  const top = rest.split("/")[0];
  return top in LAYERS;
};

/** Rewrite every import/export/require/dynamic-import specifier in `code`. */
export function rewriteSpecifiers(code, rules) {
  const unmapped = new Set();
  const out = code.replace(IMPORT_RE, (whole, a, b, c) => {
    const specifier = a ?? b ?? c;
    if (specifier == null) return whole;
    const next = applyRules(specifier, rules);
    if (next == null) {
      if (specifier.startsWith("@/lib/") && !isLayered(specifier)) unmapped.add(specifier);
      return whole;
    }
    return whole.replace(`"${specifier}"`, `"${next}"`).replace(`'${specifier}'`, `'${next}'`);
  });
  return { code: out, unmapped: [...unmapped].sort() };
}

// `import { a, type B, c as d } from "X"`, `import type { ... } from "X"`, `export { ... } from "X"`,
// `import * as ns from "X"`; the specifier is a hub module named in `partitions`.
const NAMED_RE = /(import|export)(\s+type)?\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\4;?/g;
const NAMESPACE_RE = /import\s+(type\s+)?\*\s*as\s+(\w+)\s*from\s*(["'])([^"']+)\3;?/g;

/** Split named imports from hub modules per symbol. `partitions[hub] = { default, symbols }`. */
export function partitionImports(code, partitions) {
  if (!partitions || Object.keys(partitions).length === 0) return { code, unmapped: [] };
  const unmapped = new Set();
  let out = code.replace(NAMED_RE, (whole, keyword, typeOnly, list, quote, hub) => {
    const partition = partitions[hub];
    if (!partition) return whole;
    const groups = new Map();
    for (const raw of list.split(",")) {
      const item = raw.trim();
      if (!item) continue;
      const name = item.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      const dest = partition.symbols?.[name] ?? partition.default;
      if (!partition.symbols?.[name]) unmapped.add(`${hub}#${name}`);
      if (!groups.has(dest)) groups.set(dest, []);
      groups.get(dest).push(item);
    }
    const t = typeOnly ? " type" : "";
    return [...groups]
      .map(([dest, items]) => `${keyword}${t} { ${items.join(", ")} } from ${quote}${dest}${quote};`)
      .join("\n");
  });
  out = out.replace(NAMESPACE_RE, (whole, typeOnly, name, quote, hub) => {
    const partition = partitions[hub];
    if (!partition) return whole;
    return `import ${typeOnly ? "type " : ""}* as ${name} from ${quote}${partition.default}${quote};`;
  });
  return { code: out, unmapped: [...unmapped].sort() };
}

/** Whole-word identifier renames, outside of import specifiers. */
export function renameIdentifiers(code, identifiers) {
  let out = code;
  for (const [from, to] of Object.entries(identifiers ?? {})) {
    out = out.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return out;
}

const posixJoin = (dir, spec) => {
  const parts = `${dir}/${spec}`.split("/");
  const out = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
};

const stripExt = (p) => p.replace(/\.tsx?$/, "").replace(/\/index$/, "");

/** The map entry that carries a source path, or null. Files are matched with or without extension. */
export function entryFor(path, entries) {
  const bare = stripExt(path);
  for (const entry of entries ?? []) {
    if (entry.mode === "excluded") continue;
    if (/\.tsx?$/.test(entry.from)) {
      if (stripExt(entry.from) === bare) return entry;
    } else if (path === entry.from || path.startsWith(`${entry.from}/`)) {
      return entry;
    }
  }
  return null;
}

/**
 * Relative imports survive a move only when the file and its target move together. When they
 * land in different map entries, the specifier becomes the `@/` alias of the upstream path, which
 * the later passes then map like any other alias.
 */
export function absolutizeRelative(code, sourcePath, entries) {
  if (!sourcePath?.startsWith("apps/web/") || !entries) return code;
  const own = entryFor(sourcePath, entries);
  const dir = sourcePath.split("/").slice(0, -1).join("/");
  return code.replace(IMPORT_RE, (whole, a, b, c) => {
    const specifier = a ?? b ?? c;
    if (!specifier?.startsWith(".")) return whole;
    const target = posixJoin(dir, specifier);
    const targetEntry = entryFor(target, entries);
    if (own && targetEntry === own && !/\.tsx?$/.test(own.from)) return whole;
    if (!target.startsWith("apps/web/")) return whole;
    const alias = `@/${stripExt(target.slice("apps/web/".length))}`;
    return whole.replace(`"${specifier}"`, `"${alias}"`).replace(`'${specifier}'`, `'${alias}'`);
  });
}

/** The whole codemod for one file; `sourcePath` is the upstream path, for relative imports. */
export function rewriteSource(code, { rules, partitions, identifiers, entries }, sourcePath) {
  const a0 = absolutizeRelative(code, sourcePath, entries);
  const a = partitionImports(a0, partitions);
  const b = rewriteSpecifiers(a.code, rules);
  const c = renameIdentifiers(b.code, identifiers);
  return { code: c, unmapped: [...a.unmapped, ...b.unmapped] };
}
