import { existsSync, watch as fsWatch, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { discoverSandboxFiles, IGNORED_DIRS } from "../cli/discover.js";

// The hot-reload watcher of `ratel sandbox dev`. It watches the project root (for
// `.env` and new sandbox files), the folders of the sandbox files and the folders of
// their local imports: each folder on its own, never recursively, and never
// node_modules, .git or build output.
//
// `fs.watch` is not always available. On macOS it needs the FSEvents service:
// a sandbox that denies it, or a host where FSEvents cannot make a stream,
// makes every watcher fail with EMFILE. Then the watcher polls: it reads the
// size and mtime of the sandbox files, their local imports and the root `.env`
// files every POLL_INTERVAL_MS. `RATEL_SANDBOX_WATCH=poll` polls from the start.
// Only when polling fails too does hot reload turn off.

export const RELOAD_DEBOUNCE_MS = 150;
export const POLL_INTERVAL_MS = 500;
/** The most folders one runner watches. */
export const MAX_WATCHED_DIRS = 64;
/** The most files one runner polls. */
export const MAX_POLLED_FILES = 512;
/** Set to `poll` to poll from the start instead of using `fs.watch`. */
export const WATCH_MODE_ENV = "RATEL_SANDBOX_WATCH";

/** The part of `fs.watch` the watcher uses, so a test can stand in for it. */
export type WatchFn = (
  dir: string,
  options: { recursive?: boolean },
  listener?: (event: string, file: string | Buffer | null) => void,
) => { close(): void; on(event: "error", listener: (err: Error) => void): unknown };

/** The size and mtime of a file, or undefined when it is missing. */
export type StatFn = (
  path: string,
) => { readonly size: number; readonly mtimeMs: number } | undefined;

export interface WatchHandlers {
  /** Called once per burst of relevant changes. */
  readonly onChange: () => void;
  /** Called once when the watcher starts to poll, with why. */
  readonly onPolling?: (reason: string, files: number) => void;
  /** Called once when polling fails too: hot reload is off from then on. */
  readonly onError: (message: string) => void;
}

export interface WatchOptions {
  readonly watch?: WatchFn;
  readonly stat?: StatFn;
  readonly maxDirs?: number;
  /** Default: `poll` when RATEL_SANDBOX_WATCH=poll, else `watch`. */
  readonly mode?: "watch" | "poll";
  readonly pollIntervalMs?: number;
}

export interface ProjectWatcher {
  /** How changes are seen now. */
  readonly mode: "watch" | "poll" | "off";
  /** The watched folders, relative to the root ("." is the root). Empty unless the mode is `watch`. */
  readonly dirs: readonly string[];
  /** The polled files, relative to the root. Empty unless the mode is `poll`. */
  readonly files: readonly string[];
  /** Follows the sandbox files and imports as they are now. Call it after a reload. */
  refresh(): void;
  close(): void;
}

/** Watches the folders that can change a sandbox, or polls their files. See the file comment. */
export function watchProject(
  root: string,
  handlers: WatchHandlers,
  options: WatchOptions = {},
): ProjectWatcher {
  const watch = options.watch ?? (fsWatch as unknown as WatchFn);
  const stat = options.stat ?? statOf;
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const watchers = new Map<string, ReturnType<WatchFn>>();
  const signatures = new Map<string, string>();
  let mode: ProjectWatcher["mode"] = "watch";
  let timer: NodeJS.Timeout | undefined;
  let poller: NodeJS.Timeout | undefined;

  const changeSeen = () => {
    clearTimeout(timer);
    timer = setTimeout(handlers.onChange, RELOAD_DEBOUNCE_MS);
  };
  const onEvent = (_event: string, file: string | Buffer | null) => {
    if (mode !== "watch" || (file !== null && !relevant(String(file)))) return;
    changeSeen();
  };
  const closeWatchers = () => {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
  const close = () => {
    clearTimeout(timer);
    clearInterval(poller);
    closeWatchers();
    signatures.clear();
  };
  const turnOff = (err: unknown) => {
    if (mode === "off") return;
    mode = "off";
    close();
    handlers.onError(messageOf(err));
  };

  /** Stats the bounded file list: a new file gets a baseline, a changed one a reload. */
  const poll = (baselineOnly: boolean) => {
    const { files } = projectFiles(root, options.maxDirs);
    const wanted = new Set(files);
    for (const file of signatures.keys()) if (!wanted.has(file)) signatures.delete(file);
    let changed = false;
    for (const file of files) {
      const s = stat(join(root, file));
      const signature = s ? `${s.size}:${s.mtimeMs}` : "missing";
      const before = signatures.get(file);
      signatures.set(file, signature);
      if (!baselineOnly && before !== undefined && before !== signature) changed = true;
    }
    if (changed) changeSeen();
  };
  const startPolling = (reason: string) => {
    if (mode !== "watch") return;
    closeWatchers();
    try {
      poll(true);
      mode = "poll";
      poller = setInterval(() => {
        try {
          poll(false);
        } catch (err) {
          turnOff(err);
        }
      }, interval);
      poller.unref?.();
      handlers.onPolling?.(reason, signatures.size);
    } catch (err) {
      turnOff(err);
    }
  };
  const refreshWatchers = () => {
    const wanted = new Set(projectFiles(root, options.maxDirs).dirs);
    for (const [dir, watcher] of watchers) {
      if (wanted.has(dir)) continue;
      watcher.close();
      watchers.delete(dir);
    }
    for (const dir of wanted) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(join(root, dir), { recursive: false }, onEvent);
        watcher.on("error", (err) => startPolling(messageOf(err)));
        watchers.set(dir, watcher);
      } catch (err) {
        startPolling(messageOf(err));
        return;
      }
    }
  };
  const refresh = () => {
    if (mode === "watch") refreshWatchers();
    else if (mode === "poll") {
      try {
        poll(true);
      } catch (err) {
        turnOff(err);
      }
    }
  };

  const forced = options.mode ?? (process.env[WATCH_MODE_ENV] === "poll" ? "poll" : "watch");
  if (forced === "poll") startPolling(`${WATCH_MODE_ENV}=poll`);
  else refreshWatchers();
  return {
    get mode() {
      return mode;
    },
    get dirs() {
      return mode === "watch" ? [...watchers.keys()].sort() : [];
    },
    get files() {
      return mode === "poll" ? [...signatures.keys()].sort() : [];
    },
    refresh,
    close,
  };
}

/** The folders to watch, relative to root and sorted. See projectFiles. */
export function watchedDirs(
  root: string,
  maxDirs = MAX_WATCHED_DIRS,
): { dirs: string[]; truncated: boolean } {
  const { dirs, truncated } = projectFiles(root, maxDirs);
  return { dirs, truncated };
}

/**
 * The files that can change a sandbox and their folders, relative to root and
 * sorted: the sandbox files, their local imports followed file by file, and the
 * `.env` files of the root. At most `maxDirs` folders and MAX_POLLED_FILES files.
 */
export function projectFiles(
  root: string,
  maxDirs = MAX_WATCHED_DIRS,
): { dirs: string[]; files: string[]; truncated: boolean } {
  const dirs = new Set<string>(["."]);
  const files = new Set<string>(rootEnvFiles(root));
  const seen = new Set<string>();
  const queue = discoverSandboxFiles(root).map((file) => join(root, file));
  let truncated = false;
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const dir = posix(relative(root, dirname(file))) || ".";
    if (!dirs.has(dir)) {
      if (dirs.size >= maxDirs) {
        truncated = true;
        continue;
      }
      dirs.add(dir);
    }
    if (files.size >= MAX_POLLED_FILES) {
      truncated = true;
      continue;
    }
    files.add(posix(relative(root, file)));
    queue.push(...localImports(root, file));
  }
  return { dirs: [...dirs].sort(), files: [...files].sort(), truncated };
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** The files of the relative imports of `file` that exist inside root, outside ignored folders. */
function localImports(root: string, file: string): string[] {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const target = resolveImport(resolve(dirname(file), match[1] as string));
    if (!target) continue;
    const rel = relative(root, target);
    if (rel.startsWith("..") || rel.split(sep).some((part) => IGNORED_DIRS.has(part))) continue;
    found.push(target);
  }
  return found;
}

/** `./x.js` → `./x.ts` (TypeScript ESM), `./x` → `./x.ts` or `./x/index.ts`. */
function resolveImport(base: string): string | undefined {
  const stem = base.replace(/\.(m|c)?jsx?$/, "");
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${stem}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

/** `.env` and `.env.*` in the root: the worker loads them. */
function rootEnvFiles(root: string): string[] {
  try {
    return readdirSync(root).filter((name) => name === ".env" || name.startsWith(".env."));
  } catch {
    return [];
  }
}

/** A change that can matter: any file but a dot-file, except `.env` files. */
function relevant(file: string): boolean {
  const name = file.split(/[\\/]/).pop() ?? file;
  return !name.startsWith(".") || name.startsWith(".env");
}

function statOf(path: string): { size: number; mtimeMs: number } | undefined {
  const s = statSync(path, { throwIfNoEntry: false });
  return s ? { size: s.size, mtimeMs: s.mtimeMs } : undefined;
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
