import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { BundleInfo } from "@/lib/contracts/bundle-store";

export type BundleCheck = { ok: true } | { ok: false; message: string };

/** A gzip can grow a thousand times: the check stops at this size. */
const MAX_UNPACKED_BYTES = 8 * 1024 ** 3;
const MAX_ENTRIES = 200_000;
const MAX_HEADER_BYTES = 64 * 1024;
const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
/** Two zero blocks end a tar. Some writers fill up the last record with more zeros. */
const MAX_END_BYTES = 1024 * 1024;

const FILE_TYPES = new Set(["0", "\0", "5"]);
const PAX = "x";
const GNU_LONG_NAME = "L";

/**
 * Whether the bundle has the announced hash and size, and unpacks inside its folder: only files
 * and folders, no absolute path and no `..`. Rejects when the source itself breaks.
 */
export async function checkBundle(
  body: AsyncIterable<Uint8Array>,
  bundle: BundleInfo,
): Promise<BundleCheck> {
  const hash = createHash("sha256");
  let bytes = 0;
  let broken: { error: unknown } | null = null;
  async function* counted() {
    try {
      for await (const chunk of body) {
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    } catch (error) {
      broken = { error };
      throw error;
    }
  }
  const entries = new TarEntries();
  const gunzip = createGunzip();
  const source = Readable.from(counted());
  source.on("error", (error) => gunzip.destroy(error));
  try {
    source.pipe(gunzip);
    for await (const chunk of gunzip) entries.push(chunk as Buffer);
    entries.end();
    // The gzip can end before the source: a writer can fill up its last record.
    for await (const _ of source) {
      // `counted` takes the bytes into the hash
    }
  } catch (error) {
    const failure = broken as { error: unknown } | null;
    if (failure) throw failure.error;
    if (error instanceof UnsafeBundle) return { ok: false, message: error.message };
    return { ok: false, message: "The bundle is not a gzip tar." };
  } finally {
    // A refused bundle keeps no connection.
    source.destroy();
    gunzip.destroy();
  }
  if (bytes !== bundle.bytes || hash.digest("hex") !== bundle.sha256) {
    return { ok: false, message: "The uploaded bundle does not match its SHA-256 and size." };
  }
  return { ok: true };
}

class UnsafeBundle extends Error {}

/** Reads the headers of a tar stream and throws on the first entry that is not safe. */
class TarEntries {
  private pending: Buffer = Buffer.alloc(0);
  /** Bytes of the present entry to skip, or to keep when it is a header for the next entry. */
  private skip = 0;
  private keep: { type: string; size: number; padded: number } | null = null;
  private nextName: string | null = null;
  private total = 0;
  private count = 0;
  private sawEntry = false;
  /** Bytes of zero blocks since the last entry. After two blocks the tar has ended. */
  private endBytes = 0;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.total > MAX_UNPACKED_BYTES)
      throw new UnsafeBundle("The unpacked bundle is too large.");
    if (this.skip >= chunk.length && this.pending.length === 0) {
      this.skip -= chunk.length;
      return;
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.step()) {
      // each step takes one part of `pending`
    }
  }

  end(): void {
    if (!this.sawEntry) throw new UnsafeBundle("The bundle has no files.");
    if (this.skip > 0 || this.keep)
      throw new UnsafeBundle("The bundle ends in the middle of a file.");
  }

  private step(): boolean {
    if (this.skip > 0) {
      const taken = Math.min(this.skip, this.pending.length);
      this.take(taken);
      this.skip -= taken;
      return taken > 0 && this.pending.length > 0;
    }
    if (this.keep) {
      if (this.pending.length < this.keep.padded) return false;
      const { type, size, padded } = this.keep;
      const data = this.take(padded).subarray(0, size);
      this.keep = null;
      this.nextName = type === PAX ? (paxPath(data) ?? this.nextName) : cString(data);
      return true;
    }
    if (this.pending.length < BLOCK) return false;
    this.header(this.take(BLOCK));
    return true;
  }

  private header(block: Buffer): void {
    if (block.equals(ZERO_BLOCK)) {
      this.endBytes += BLOCK;
      if (this.endBytes > MAX_END_BYTES)
        throw new UnsafeBundle("The bundle has data after its end.");
      return;
    }
    if (this.endBytes > 0) throw new UnsafeBundle("The bundle has data after its end.");
    if (++this.count > MAX_ENTRIES) throw new UnsafeBundle("The bundle has too many files.");
    const size = octal(block.subarray(124, 136));
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const type = String.fromCharCode(block[156] ?? 0);
    if (type === PAX || type === GNU_LONG_NAME) {
      if (size > MAX_HEADER_BYTES)
        throw new UnsafeBundle("The bundle has a header that is too large.");
      this.keep = { type, size, padded };
      return;
    }
    const prefix = cString(block.subarray(345, 500));
    const short = cString(block.subarray(0, 100));
    const name = this.nextName ?? (prefix ? `${prefix}/${short}` : short);
    this.nextName = null;
    if (!FILE_TYPES.has(type)) {
      throw new UnsafeBundle(`The bundle entry ${quote(name)} is not a file or a folder.`);
    }
    if (
      name === "" ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").includes("..")
    ) {
      throw new UnsafeBundle(`The bundle entry ${quote(name)} leaves the project folder.`);
    }
    this.sawEntry = true;
    this.skip = padded;
  }

  private take(length: number): Buffer {
    const taken = this.pending.subarray(0, length);
    this.pending = this.pending.subarray(length);
    return taken;
  }
}

/** The `path` record of a pax header. Records are `<length> <key>=<value>\n`. */
function paxPath(data: Buffer): string | null {
  let path: string | null = null;
  for (let at = 0; at < data.length; ) {
    const space = data.indexOf(0x20, at);
    const length = space < 0 ? 0 : Number(data.subarray(at, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= space - at || at + length > data.length) {
      throw new UnsafeBundle("The bundle has a header that is not valid.");
    }
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    if (record.startsWith("path=")) path = record.slice("path=".length);
    // A size of its own would let a reader see other entries than this check sees.
    if (record.startsWith("size="))
      throw new UnsafeBundle("The bundle has a file that is too large.");
    at += length;
  }
  return path;
}

function octal(field: Buffer): number {
  const text = cString(field).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new UnsafeBundle("The bundle has a header that is not valid.");
  return Number.parseInt(text, 8);
}

function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function quote(name: string): string {
  return JSON.stringify(name.slice(0, 200));
}
