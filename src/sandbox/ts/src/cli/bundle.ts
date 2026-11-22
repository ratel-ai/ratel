import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { CliError } from "./args.js";
import { IGNORED_DIRS } from "./discover.js";

// The bundle of `ratel sandbox push`: the project files as a tar.gz. In a git
// checkout the file list is git's (tracked and untracked, minus .gitignore).
// Outside git it is a walk of the project. Both always drop .env files,
// dependencies, .git and build output. The archive is deterministic: the same
// files give the same bytes and the same SHA-256.

/** The largest bundle push uploads: 50 MB of tar.gz. */
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

export interface Bundle {
  /** POSIX paths relative to the project root, sorted. */
  readonly files: readonly string[];
  /** The tar.gz bytes. */
  readonly data: Buffer;
  /** Lowercase hex SHA-256 of `data`. */
  readonly sha256: string;
  /** The sum of the file sizes before compression. */
  readonly rawBytes: number;
}

export interface BuildBundleOptions {
  readonly maxBytes?: number;
}

/** Collects the project files and packs them. Throws a CliError over the size limit. */
export function buildBundle(root: string, options: BuildBundleOptions = {}): Bundle {
  const maxBytes = options.maxBytes ?? MAX_BUNDLE_BYTES;
  const files = bundleFiles(root);
  const entries = files.map((file) => ({ path: file, ...readEntry(join(root, file)) }));
  const rawBytes = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  const data = gzipSync(tar(entries), { level: 9 });
  if (data.length > maxBytes)
    throw new CliError(
      `the bundle is ${formatBytes(data.length)} (${files.length} files), over the limit of ${formatBytes(maxBytes)}: add the large files to .gitignore`,
    );
  return { files, data, sha256: createHash("sha256").update(data).digest("hex"), rawBytes };
}

/** The files of the bundle: POSIX paths relative to root, sorted. */
export function bundleFiles(root: string): string[] {
  const listed = gitFiles(root) ?? walkFiles(root);
  return [...new Set(listed)].filter((file) => keep(file) && isFile(join(root, file))).sort();
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
  return !parts.slice(0, -1).some((dir) => IGNORED_DIRS.has(dir));
}

/** Tracked and untracked files under root that .gitignore keeps, or null outside git. */
function gitFiles(root: string): string[] | null {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
      { cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 },
    );
    return out.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walkFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile()) {
        found.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return found;
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
