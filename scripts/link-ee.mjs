#!/usr/bin/env node
// The private repository is checked out at ee/src (a git submodule in the real setup). Its
// modules need nothing: ee/src is a real directory inside ee/, so they resolve their
// dependencies through ee/package.json and edits show up live in the dev server.
//
// Routes are the exception. Next.js only routes files under app/, so this script copies the
// route stubs the private repository ships into app/(ee). It copies rather than symlinks:
// `next build` follows a symlinked route directory but `next dev` does not discover routes
// inside one. The stubs are one-line re-exports, so a copy costs nothing; the code they point
// at stays in ee/src/src. Without ee/src the repository is the open-source edition.
//
// The proxy is the same exception: Next.js only reads it from web/src/proxy.ts, and the
// open-source edition must not have one.
//
// So are static files: Next.js serves only web/public, so the files of the edition's
// public/ folder (the invite email's images) are copied there, beside the app's own. Real
// files, not links: the image copies web/public on its own, and a link out of the app
// would not survive it. The placed paths are listed in web/.ee-public.json so they can be
// removed without the checkout; both are gitignored. A file the app ships itself is never
// replaced.
//
//   node scripts/link-ee.mjs           install the commercial routes; fails if the checkout is missing
//   node scripts/link-ee.mjs --auto    install them if the checkout is there, remove them otherwise;
//                                      never fails. Runs before every dev and build, and
//                                      refreshes the checkout's git hooks when it ships an installer
//   node scripts/link-ee.mjs --unlink  remove them, back to the open-source tree

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The private repository's checkout (ee/src) keeps its modules under its own src/.
const EE_SRC = join(ROOT, "ee", "src", "src");
const ROUTES = join(EE_SRC, "routes");
// Generated and gitignored: nothing tracked ever lives here.
const TARGET = join(ROOT, "web", "src", "app", "(ee)");
const HOOK_INSTALLER = join(ROOT, "ee", "src", "scripts", "install-hooks.sh");
const PROXY_SOURCE = join(EE_SRC, "proxy.ts");
const PROXY_TARGET = join(ROOT, "web", "src", "proxy.ts");
const PUBLIC_SOURCE = join(EE_SRC, "public");
const PUBLIC_TARGET = join(ROOT, "web", "public");
// Outside public/, so it is never served.
const PUBLIC_PLACED = join(ROOT, "web", ".ee-public.json");

/** Every file under a folder, as paths relative to it. */
const filesUnder = (folder) =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(folder, join(d.parentPath, d.name)));

const removePublic = () => {
  if (!existsSync(PUBLIC_PLACED)) return;
  for (const file of JSON.parse(readFileSync(PUBLIC_PLACED, "utf8"))) {
    rmSync(join(PUBLIC_TARGET, file), { force: true });
    // Drop the folders the placed file leaves empty, up to public/ itself.
    for (let dir = dirname(file); dir !== "."; dir = dirname(dir)) {
      const full = join(PUBLIC_TARGET, dir);
      if (!existsSync(full) || readdirSync(full).length) break;
      rmdirSync(full);
    }
  }
  rmSync(PUBLIC_PLACED, { force: true });
};

const installPublic = () => {
  if (!existsSync(PUBLIC_SOURCE)) return;
  const placed = [];
  for (const file of filesUnder(PUBLIC_SOURCE)) {
    const to = join(PUBLIC_TARGET, file);
    if (existsSync(to)) {
      console.warn(`kept web/public/${file.split(sep).join("/")}: the app ships its own`);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(PUBLIC_SOURCE, file), to);
    placed.push(file);
  }
  if (placed.length) writeFileSync(PUBLIC_PLACED, `${JSON.stringify(placed, null, 2)}\n`);
};

const remove = () => {
  rmSync(TARGET, { recursive: true, force: true });
  rmSync(PROXY_TARGET, { force: true });
  removePublic();
};
const install = () => {
  remove();
  cpSync(ROUTES, TARGET, { recursive: true });
  if (existsSync(PROXY_SOURCE)) cpSync(PROXY_SOURCE, PROXY_TARGET);
  installPublic();
};

/** Best effort: a failure warns, and dev and build go on. */
const installHooks = () => {
  if (!existsSync(HOOK_INSTALLER)) return;
  const run = spawnSync("sh", [HOOK_INSTALLER], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    timeout: 15_000,
  });
  if (run.status !== 0) {
    console.warn(`could not install the git hooks: ${run.error?.message ?? `exit ${run.status}`}`);
  }
};

const mode = process.argv[2] ?? "--link";

if (mode === "--auto") {
  existsSync(ROUTES) ? install() : remove();
  installHooks();
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
