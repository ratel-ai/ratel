import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import ignore, { type Ignore } from "ignore";
import { CliError } from "./args.js";
import { IGNORED_DIRS } from "./discover.js";

// The bundle of `ratel sandbox push`: the project files as a tar.gz. In a git
// work tree the file list is git's (tracked and untracked, minus .gitignore).
// Outside one it is a walk that applies the project's .gitignore files as git
// does. When git fails inside a work tree, push is refused: it never falls back
// to a walk that could upload ignored files. Every path always drops .env
// files, dependencies, .git (a folder or a file) and build output. The archive
// is deterministic: the same files give the same bytes and the same SHA-256.

/** The largest bundle push uploads: 50 MB of tar.gz. */
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

/** Where the ignore rules came from: git itself, or the .gitignore files outside a work tree. */
export type BundleSource = "git" | "gitignore";

export const SOURCE_LABELS: Readonly<Record<BundleSource, string>> = {
  git: "git (tracked and untracked files, minus .gitignore)",
  gitignore: ".gitignore files (not a git work tree)",
};

export interface Bundle {
  /** POSIX paths relative to the project root, sorted. */
  readonly files: readonly string[];
  readonly source: BundleSource;
  /** The tar.gz bytes. */
  readonly data: Buffer;
  /** Lowercase hex SHA-256 of `data`. */
  readonly sha256: string;
  /** The sum of the file sizes before compression. */
  readonly rawBytes: number;
}

/**
 * Runs git with `args` in `cwd` and returns its stdout. Throws as execFileSync
 * does: `code` ENOENT when git is not installed, else `status` and `stderr`.
 */
export type GitRunner = (args: readonly string[], cwd: string) => string;

export interface BundleFilesOptions {
  readonly git?: GitRunner;
}

export interface BuildBundleOptions extends BundleFilesOptions {
  readonly maxBytes?: number;
}

/** Collects the project files and packs them. Throws a CliError over the size limit or when git fails. */
export function buildBundle(root: string, options: BuildBundleOptions = {}): Bundle {
  const maxBytes = options.maxBytes ?? MAX_BUNDLE_BYTES;
  const { files, source } = bundleFiles(root, options);
  const entries = files.map((file) => ({ path: file, ...readEntry(join(root, file)) }));
  const rawBytes = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  const data = gzipSync(tar(entries), { level: 9 });
  if (data.length > maxBytes)
    throw new CliError(
      `the bundle is ${formatBytes(data.length)} (${files.length} files), over the limit of ${formatBytes(maxBytes)}: add the large files to .gitignore`,
    );
  return {
    files,
    source,
    data,
    sha256: createHash("sha256").update(data).digest("hex"),
    rawBytes,
  };
}

/** The files of the bundle (POSIX paths relative to root, sorted) and where the ignore rules came from. */
export function bundleFiles(
  root: string,
  options: BundleFilesOptions = {},
): { files: string[]; source: BundleSource } {
  const git = options.git ?? runGit;
  const source: BundleSource = insideWorkTree(root, git) ? "git" : "gitignore";
  const listed = source === "git" ? gitFiles(root, git) : walkFiles(root);
  const files = [...new Set(listed)].filter((file) => keep(file) && isFile(join(root, file)));
  return { files: files.sort(), source };
}

/** A size such as `1.3 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Never in a bundle, whatever .gitignore says: secrets, dependencies, VCS and build output. */
function keep(file: string): boolean {
  const parts = file.split("/");
  const name = parts[parts.length - 1] ?? "";
  if (name === ".env" || name.startsWith(".env.")) return false;
  if (parts.includes(".git")) return false;
  return !parts.slice(0, -1).some((dir) => IGNORED_DIRS.has(dir));
}

/**
 * True inside a git work tree. False when git says this is no repository, or
 * when git is not installed. Any other failure refuses the push: the ignore
 * rules git would apply are unknown.
 */
function insideWorkTree(root: string, git: GitRunner): boolean {
  try {
    return git(["rev-parse", "--is-inside-work-tree"], root).trim() === "true";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    const why = gitFailure(err);
    if (/not a git repository/i.test(why)) return false;
    throw new CliError(
      `git cannot tell if the project is a work tree (${why}): push refused, so no file outside the .gitignore rules is uploaded`,
    );
  }
}

/** Tracked and untracked files under root that .gitignore keeps. Throws a CliError when git fails. */
function gitFiles(root: string, git: GitRunner): string[] {
  try {
    const out = git(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
      root,
    );
    return out.split("\0").filter(Boolean);
  } catch (err) {
    throw new CliError(
      `git cannot list the project files (${gitFailure(err)}): push refused, so no file outside the .gitignore rules is uploaded`,
    );
  }
}

/** Every file under root that the .gitignore files keep, read as git reads them (root and nested, with negations). */
function walkFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rules: readonly IgnoreLayer[]): void => {
    const own = readIgnoreFile(root, dir);
    const layers = own ? [...rules, own] : rules;
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || IGNORED_DIRS.has(entry.name)) continue;
        // As in git, a file inside an ignored folder cannot be re-included.
        if (!ignored(`${path}/`, layers)) walk(path, layers);
      } else if (entry.isFile() && !ignored(path, layers)) {
        found.push(path);
      }
    }
  };
  walk("", []);
  return found;
}

interface IgnoreLayer {
  /** The folder of the .gitignore file, relative to root: "" for the root. */
  readonly base: string;
  readonly rules: Ignore;
}

function readIgnoreFile(root: string, dir: string): IgnoreLayer | undefined {
  const file = join(root, dir, ".gitignore");
  if (!existsSync(file) || !lstatSync(file).isFile()) return undefined;
  return { base: dir, rules: ignore().add(readFileSync(file, "utf8")) };
}

/** The last .gitignore with a matching rule decides, as in git: a deeper file overrides a parent one. */
function ignored(path: string, layers: readonly IgnoreLayer[]): boolean {
  let result = false;
  for (const layer of layers) {
    const relativePath = layer.base === "" ? path : path.slice(layer.base.length + 1);
    const verdict = layer.rules.test(relativePath);
    if (verdict.ignored) result = true;
    else if (verdict.unignored) result = false;
  }
  return result;
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** The first line git wrote to stderr, else the error message. */
function gitFailure(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  const text =
    typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString() : "";
  const line = text.split("\n").find((l) => l.trim() !== "");
  return line?.trim() ?? (err instanceof Error ? err.message : String(err));
}

/** A regular file: no symlink, no deleted path that git still tracks. */
function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function readEntry(path: string): { data: Buffer; mode: number } {
  const executable = (lstatSync(path).mode & 0o111) !== 0;
  return { data: readFileSync(path), mode: executable ? 0o755 : 0o644 };
}

interface TarEntry {
  readonly path: string;
  readonly data: Buffer;
  readonly mode: number;
}

/** A ustar archive with a zero mtime and owner, so the bytes depend on the files only. */
function tar(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(tarHeader(entry));
    blocks.push(entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512);
  const [prefix, name] = splitTarPath(entry.path);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, entry.mode, 100, 8);
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, entry.data.length, 124, 12);
  writeOctal(header, 0, 136, 12); // mtime
  header.fill(" ", 148, 156); // checksum placeholder
  header.write("0", 156, 1, "ascii"); // regular file
  header.write("ustar\u000000", 257, 8, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, 8, "ascii");
  return header;
}

/** ustar keeps a path of up to 255 bytes as a prefix (155) and a name (100), split on a '/'. */
function splitTarPath(path: string): [prefix: string, name: string] {
  if (Buffer.byteLength(path) <= 100) return ["", path];
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return [prefix, name];
  }
  throw new CliError(`the path ${path} is too long for the bundle (over 255 bytes)`);
}

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\u0000`, offset, length, "ascii");
}
