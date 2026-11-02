#!/usr/bin/env node
// Exit 1 when the composed schema has changes no committed migration covers: runs drizzle-kit
// generate on a copy of the migrations folder and looks for a new file. Add a migration with
// `pnpm --filter @ratel/platform db:generate --name <what-it-does>`. Never edit an existing one.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(APP_ROOT, "lib/platform/db/migrations");

const sqlFiles = (dir) => readdirSync(dir).filter((file) => file.endsWith(".sql"));

const tmp = mkdtempSync(join(tmpdir(), "ratel-migrations-"));
try {
  cpSync(MIGRATIONS, tmp, { recursive: true });
  execFileSync(
    "pnpm",
    // drizzle-kit prefixes --out with "./" when it reads the snapshots, so an absolute path breaks.
    [
      "exec",
      "drizzle-kit",
      "generate",
      "--dialect",
      "postgresql",
      "--out",
      relative(APP_ROOT, tmp),
      "--schema",
      "./lib/**/schema.ts",
    ],
    { cwd: APP_ROOT, stdio: "ignore" },
  );
  const added = sqlFiles(tmp).filter((file) => !sqlFiles(MIGRATIONS).includes(file));
  if (added.length > 0) {
    console.error(
      "the schema has changes no migration covers; run pnpm --filter @ratel/platform db:generate --name <what-it-does>",
    );
    process.exit(1);
  }
  console.log("migrations match the schema");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
