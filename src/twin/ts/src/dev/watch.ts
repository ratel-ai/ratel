import { existsSync, watch as fsWatch, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { discoverTwinFiles, IGNORED_DIRS } from "../cli/discover.js";

// The hot-reload watcher of `ratel dev`. It watches the project root (for
// `.env` and new twin files), the folders of the twin files and the folders of
// their local imports: each folder on its own, never recursively, and never
// node_modules, .git or build output. A recursive watch of the root put the
// whole tree into the shared macOS FSEvents stream of the process: when that
// stream fails (EMFILE), every watcher gets an `error` event, and with no
// handler the runner crashed. Now a watcher error turns hot reload off with one
// line, and the runner keeps serving the last good code.

export const RELOAD_DEBOUNCE_MS = 150;
/** The most folders one runner watches. */
export const MAX_WATCHED_DIRS = 64;

/** The part of `fs.watch` the watcher uses, so a test can stand in for it. */
export type WatchFn = (
  dir: string,
  options: { recursive?: boolean },
  listener?: (event: string, file: string | Buffer | null) => void,
) => { close(): void; on(event: "error", listener: (err: Error) => void): unknown };

export interface WatchHandlers {
  /** Called once per burst of relevant changes. */
  readonly onChange: () => void;
  /** Called once when a watcher fails: hot reload is off from then on. */
  readonly onError: (message: string) => void;
}

export interface WatchOptions {
  readonly watch?: WatchFn;
  readonly maxDirs?: number;
}

export interface ProjectWatcher {
  /** The watched folders, relative to the root ("." is the root). Empty once hot reload is off. */
  readonly dirs: readonly string[];
  /** Watches the folders of the twin files and imports as they are now. Call it after a reload. */
  refresh(): void;
  close(): void;
}

/** Watches the folders that can change a twin. See the file comment. */
export function watchProject(
  root: string,
  handlers: WatchHandlers,
  options: WatchOptions = {},
): ProjectWatcher {
  const watch = options.watch ?? (fsWatch as unknown as WatchFn);
  const watchers = new Map<string, ReturnType<WatchFn>>();
  let timer: NodeJS.Timeout | undefined;
  let failed = false;

  const changed = (_event: string, file: string | Buffer | null) => {
    if (failed || (file !== null && !relevant(String(file)))) return;
    clearTimeout(timer);
    timer = setTimeout(handlers.onChange, RELOAD_DEBOUNCE_MS);
  };
  const close = () => {
    clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
  const fail = (err: unknown) => {
    if (failed) return;
    failed = true;
    close();
    handlers.onError(err instanceof Error ? err.message : String(err));
  };
  const refresh = () => {
    if (failed) return;
    const wanted = new Set(watchedDirs(root, options.maxDirs).dirs);
    for (const [dir, watcher] of watchers) {
      if (wanted.has(dir)) continue;
      watcher.close();
      watchers.delete(dir);
    }
    for (const dir of wanted) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(join(root, dir), { recursive: false }, changed);
        watcher.on("error", fail);
        watchers.set(dir, watcher);
      } catch (err) {
        fail(err);
        return;
      }
    }
  };

  refresh();
  return {
    get dirs() {
      return [...watchers.keys()].sort();
    },
    refresh,
    close,
  };
}

/**
 * The folders to watch, relative to root and sorted: the root, the folders of
 * the twin files, and the folders of their local imports, followed file by
 * file. At most `maxDirs`, nearest first.
 */
export function watchedDirs(
  root: string,
  maxDirs = MAX_WATCHED_DIRS,
): { dirs: string[]; truncated: boolean } {
  const dirs = new Set<string>(["."]);
  const seen = new Set<string>();
  const queue = discoverTwinFiles(root).map((file) => join(root, file));
  let truncated = false;
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const dir = relative(root, dirname(file)).split(sep).join("/") || ".";
    if (!dirs.has(dir)) {
      if (dirs.size >= maxDirs) {
        truncated = true;
        continue;
      }
      dirs.add(dir);
    }
    queue.push(...localImports(root, file));
  }
  return { dirs: [...dirs].sort(), truncated };
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

/** A change that can matter: any file but a dot-file, except `.env` files. */
function relevant(file: string): boolean {
  const name = file.split(/[\\/]/).pop() ?? file;
  return !name.startsWith(".") || name.startsWith(".env");
}
