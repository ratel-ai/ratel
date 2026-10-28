// Import-specifier codemod for the platform sync (ADR-0030). Pure: `rewriteSpecifiers` takes
// source text and the rule list and returns the rewritten text plus the `@/lib/*` specifiers no
// rule mapped. Rules come from `rewrites.json` plus every `apps/web/lib/<from> -> apps/web/lib/<to>`
// pair in `map.json`, longest `from` first, so a specific rule wins over a broader one.

import { IMPORT_RE } from "../check-ee-boundary.mjs";
import { LAYERS } from "../check-layers.mjs";

const LIB = "apps/web/lib/";

/** Rules in matching order: explicit rules from rewrites.json, then the map's lib moves. */
export function buildRules(map, rewrites) {
  const explicit = (rewrites?.rules ?? []).map((r) => ({ ...r, except: r.except ?? [] }));
  const derived = [];
  for (const entry of map.entries ?? []) {
    if (entry.mode === "excluded" || !entry.to) continue;
    if (!entry.from.startsWith(LIB) || !entry.to.startsWith(LIB)) continue;
    const from = `@/lib/${entry.from.slice(LIB.length)}`.replace(/\.tsx?$/, "");
    const to = `@/lib/${entry.to.slice(LIB.length)}`.replace(/\.tsx?$/, "");
    if (from === to) continue;
    derived.push({ from, to, except: [], exact: entry.from.endsWith(".ts") || entry.from.endsWith(".tsx") });
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
