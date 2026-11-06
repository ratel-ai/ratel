#!/usr/bin/env node
// DESIGN.md token check for the design system and the v2 views: class strings use the semantic
// tokens (bg-app, text-fg-muted, border-line, bg-accent, ...) and nothing else. Ported from the
// ESLint rule the Cloud app used; biome has no custom rules, so this runs as a test.
//   node scripts/check-ds-tokens.mjs            from apps/web; scans the scoped folders below
// `findDsViolations(value)` is exported on its own so it can be tested without a file tree.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Folders held to the rule; v1 screens are untouched until they are rebuilt. */
export const SCOPED = ["components/shell", "components/intent-map"];
const SCOPED_GLOB = /(^|\/)v2\//;

const COLOR_UTILITY =
  "(?:bg|text|border(?:-[trblxy])?|ring|ring-offset|fill|stroke|from|via|to|outline|divide|placeholder|decoration|shadow|accent|caret)";
const LEGACY = new RegExp(
  `^${COLOR_UTILITY}-(?:canvas|base-deep|forest(?:-\\d+)?|cream(?:-dim)?|warm-muted|coral(?:-deep)?|ink|near-black|paper|indigo(?:-\\d+)?|teal|green|dot-on|ctx-[a-z-]+)(?:\\/\\d+)?$`,
);
const RAW_PALETTE = new RegExp(
  `^${COLOR_UTILITY}-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3})(?:\\/\\d+)?$`,
);
const ARBITRARY_COLOR = new RegExp(`^${COLOR_UTILITY}-\\[(?:#|rgb|hsl|oklch|color-mix)`);
const ARBITRARY_TEXT_PX = /^text-\[(\d+(?:\.\d+)?)px\]$/;

export const MESSAGES = {
  legacy:
    "Legacy palette class. Use the semantic tokens (bg-app, text-fg-muted, border-line, bg-accent, ...).",
  raw: "Raw color. Use a semantic token; status and chart colors have their own.",
  small: "Text under 12px. The smallest size is text-xs (12/16).",
  eyebrow: "Uppercase tracked label. Section headings are sentence case, text-sm font-semibold.",
};

/** The utility itself, without variants (`hover:`, `md:`, `data-x:`) or the important mark. */
function bareUtility(className) {
  return className.slice(className.lastIndexOf(":") + 1).replace(/^!|!$/g, "");
}

/** @returns {("legacy" | "raw" | "small" | "eyebrow")[]} each violation kind once */
export function findDsViolations(value) {
  const found = new Set();
  const utilities = value.split(/\s+/).filter(Boolean).map(bareUtility);
  for (const utility of utilities) {
    if (LEGACY.test(utility)) found.add("legacy");
    else if (RAW_PALETTE.test(utility) || ARBITRARY_COLOR.test(utility)) found.add("raw");
    const px = utility.match(ARBITRARY_TEXT_PX);
    if (px && Number(px[1]) < 12) found.add("small");
  }
  if (
    utilities.includes("uppercase") &&
    utilities.some((utility) => utility.startsWith("tracking-"))
  ) {
    found.add("eyebrow");
  }
  return [...found];
}

// String and template literals, one per match; good enough for class strings, which never nest.
const LITERAL_RE = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

/** Violations in one source text: `[{ line, kind }]`. */
export function scanSource(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(LITERAL_RE)) {
      for (const kind of findDsViolations(m[1] ?? m[2] ?? m[3] ?? ""))
        out.push({ line: i + 1, kind });
    }
  });
  return out;
}

function inScope(rel) {
  return SCOPED.some((s) => rel === s || rel.startsWith(`${s}/`)) || SCOPED_GLOB.test(rel);
}

export function scanTree(root = APP_ROOT) {
  const hits = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        const rel = relative(root, full).split("\\").join("/");
        if (!inScope(rel)) continue;
        for (const h of scanSource(readFileSync(full, "utf8"))) hits.push({ path: rel, ...h });
      }
    }
  };
  for (const top of ["components", "app"]) if (existsSync(join(root, top))) visit(join(root, top));
  return hits;
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hits = scanTree();
  for (const h of hits) console.error(`${h.path}:${h.line}  ${MESSAGES[h.kind]}`);
  if (hits.length > 0) process.exit(1);
  console.log("design tokens clean in the scoped folders");
}
