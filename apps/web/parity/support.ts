import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ossFiles } from "./normalise";
import type { SourceTree } from "./source-probes";

/** Shared by the parity tests (temporary parity harness, RTL-45). */

const PARITY_DIR = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = join(PARITY_DIR, "..");

/** What Ratel Cloud answered for a subject, as `scripts/platform-parity/capture.mts` wrote it. */
export function golden<T = unknown>(subject: string): T {
  const file = JSON.parse(readFileSync(join(PARITY_DIR, "golden", `${subject}.json`), "utf8")) as {
    value: T;
  };
  return file.value;
}

/** A value as it is stored: the same round trip the captured files went through. */
export function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (v instanceof Map ? { $map: [...v.entries()] } : v)),
  );
}

/** A stored value with its Maps rebuilt. */
export function revive<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), (_key, v) =>
    v && typeof v === "object" && Array.isArray((v as { $map?: unknown }).$map)
      ? new Map((v as { $map: [unknown, unknown][] }).$map)
      : v,
  ) as T;
}

const show = (value: unknown): string => {
  const text = value === undefined ? "nothing" : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
};

/** Every place two stored values differ, as `path: here …, Cloud …`. */
export function differences(
  here: unknown,
  cloud: unknown,
  path = "",
  out: string[] = [],
): string[] {
  if (Object.is(here, cloud)) return out;
  const bothObjects =
    here !== null && cloud !== null && typeof here === "object" && typeof cloud === "object";
  if (!bothObjects || Array.isArray(here) !== Array.isArray(cloud)) {
    out.push(`${path || "(value)"}: here ${show(here)}, Cloud ${show(cloud)}`);
    return out;
  }
  const a = here as Record<string, unknown>;
  const b = cloud as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    differences(
      a[key],
      b[key],
      Array.isArray(here) ? `${path}[${key}]` : path ? `${path}.${key}` : key,
      out,
    );
  }
  return out;
}

/**
 * This repository's answer is Cloud's. Compared as stored values (the captured files are JSON),
 * and reported as a short list of the places that differ rather than a dump of both sides.
 */
export function same(here: unknown, cloud: unknown): void {
  const found = differences(plain(here), plain(cloud));
  if (found.length === 0) return;
  const shown = found.slice(0, 12).map((line) => `  ${line}`);
  const more = found.length > shown.length ? [`  … and ${found.length - shown.length} more`] : [];
  assert.fail(
    [
      `${found.length} difference${found.length === 1 ? "" : "s"} from Cloud:`,
      ...shown,
      ...more,
    ].join("\n"),
  );
}

/** A module that may not exist yet: an open item's fix adds it. */
export async function load<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

/** What a page's `redirect()` or `permanentRedirect()` says: Next throws it as a digest. */
export async function thrownRedirect(
  run: () => unknown,
): Promise<{ destination: string; status: number } | null> {
  try {
    await run();
  } catch (thrown) {
    const digest = (thrown as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) {
      const parts = digest.split(";");
      return { destination: parts.slice(2, -2).join(";"), status: Number(parts.at(-2)) };
    }
    throw thrown;
  }
  return null;
}

const SOURCE = /\.(ts|tsx)$/;
const TEST = /\.test\.(ts|tsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === "parity") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(entry) && !TEST.test(entry)) out.push(full);
  }
  return out;
}

// A pattern ending in "/**" is every source file under that folder; "/**" followed by a file
// name is every file of that name under it.
function expand(pattern: string): string[] {
  const star = pattern.indexOf("/**");
  if (star < 0) return [join(APP_ROOT, pattern)];
  const name = pattern.slice(star + 3).replace(/^\//, "");
  return walk(join(APP_ROOT, pattern.slice(0, star))).filter(
    (file) => name === "" || file.endsWith(`/${name}`),
  );
}

/** This repository's sources, addressed by Cloud's paths through `normalise.ts`. */
export const ossTree: SourceTree = {
  read: (cloudPath) =>
    ossFiles(cloudPath)
      .flatMap(expand)
      .sort()
      .map((file) => {
        try {
          return readFileSync(file, "utf8");
        } catch {
          return "";
        }
      })
      .join("\n"),
};
