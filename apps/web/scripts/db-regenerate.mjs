#!/usr/bin/env node
// The open-source edition's migration set is one generated file, `0000_init.sql`, regenerated
// from the composed schema until the first OSS release tag (ADR-0030). After that tag, drop this
// script and append migrations with `drizzle-kit generate` as usual.
//
//   node scripts/db-regenerate.mjs            rewrite lib/platform/db/migrations from the schema
//   node scripts/db-regenerate.mjs --check    exit 1 when the committed SQL differs from the schema
//
// drizzle-kit stamps the journal with the current time; it is pinned to 0 so a regeneration
// with no schema change is byte-identical and `--check` can diff it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(APP_ROOT, "lib/platform/db/migrations");
// One glob: the drizzle-kit CLI honours only the last --schema flag, so a list would drop files.
const SCHEMA = ["./lib/**/schema.ts"];

function generate(out) {
  rmSync(out, { recursive: true, force: true });
  execFileSync(
    "pnpm",
    [
      "exec",
      "drizzle-kit",
      "generate",
      "--dialect",
      "postgresql",
      "--out",
      out,
      "--name",
      "init",
      ...SCHEMA.flatMap((s) => ["--schema", s]),
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const journalPath = join(out, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  for (const entry of journal.entries ?? []) entry.when = 0;
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}

function sqlFiles(dir) {
  if (!existsSync(dir)) return new Map();
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => [f, readFileSync(join(dir, f), "utf8")]),
  );
}

if (process.argv.includes("--check")) {
  const tmp = mkdtempSync(join(tmpdir(), "ratel-migrations-"));
  try {
    generate(tmp);
    const committed = sqlFiles(OUT);
    const fresh = sqlFiles(tmp);
    const names = new Set([...committed.keys(), ...fresh.keys()]);
    const drift = [...names].filter((n) => committed.get(n) !== fresh.get(n));
    if (drift.length > 0) {
      console.error(
        `migrations drift from the schema: ${drift.join(", ")}; run pnpm --filter @ratel/platform db:regenerate`,
      );
      process.exit(1);
    }
    console.log("migrations match the schema");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  generate(OUT);
  console.log(`regenerated ${OUT}`);
}
