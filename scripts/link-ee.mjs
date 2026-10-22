#!/usr/bin/env node
// The private repository is checked out at ee/src (a git submodule in the real setup). Its
// modules need nothing: ee/src is a real directory inside ee/, so they resolve their
// dependencies through ee/package.json and edits show up live in the dev server.
//
// Routes are the exception. Next.js only routes files under app/, so this script copies the
// route stubs the private repository ships into app/(ee). It copies rather than symlinks:
// `next build` follows a symlinked route directory but `next dev` does not discover routes
// inside one. The stubs are one-line re-exports, so a copy costs nothing; the code they point
// at stays in ee/src. Without ee/src the repository is the open-source edition.
//
//   node scripts/link-ee.mjs           install the commercial routes; fails if the checkout is missing
//   node scripts/link-ee.mjs --auto    install them if the checkout is there, remove them otherwise;
//                                      never fails. Runs before every dev and build
//   node scripts/link-ee.mjs --unlink  remove them, back to the open-source tree

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES = join(ROOT, "ee", "src", "routes");
// Generated and gitignored: nothing tracked ever lives here.
const TARGET = join(ROOT, "apps", "web", "app", "(ee)");

const remove = () => rmSync(TARGET, { recursive: true, force: true });
const install = () => {
  remove();
  cpSync(ROUTES, TARGET, { recursive: true });
};

const mode = process.argv[2] ?? "--link";

if (mode === "--auto") {
  existsSync(ROUTES) ? install() : remove();
} else if (mode === "--unlink") {
  remove();
  console.log("ee routes removed: open-source tree");
} else if (mode === "--link") {
  // Fail fast: a missing checkout must stop here, not surface later as a missing route.
  if (!existsSync(ROUTES)) {
    console.error(
      `commercial routes not found at ${relative(ROOT, ROUTES)}: is the private repository checked out at ee/src?`,
    );
    process.exit(1);
  }
  install();
  console.log(`installed ${relative(ROOT, TARGET)} from ${relative(ROOT, ROUTES)}`);
} else {
  console.error(`unknown option ${mode}; use --link, --auto or --unlink`);
  process.exit(1);
}
