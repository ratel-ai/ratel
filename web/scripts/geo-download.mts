/**
 * Download the current DB-IP Lite file, which resolves IP addresses to a country and a region for the
 * geography widget (docs/geography.md). Run it again each month; the app takes the new file by itself.
 *
 *   GEO_DATABASE_PATH=/var/lib/ratel/geo.mmdb pnpm --filter @ratel/platform geo:download [city|country]
 *
 * `city` (the default, about 130 MB) knows regions; `country` (about 8 MB) knows countries only.
 * IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const edition = process.argv[2] ?? "city";
const path = process.env.GEO_DATABASE_PATH?.trim();
if (!path || !["city", "country"].includes(edition)) {
  console.error("usage: GEO_DATABASE_PATH=<file> geo:download [city|country]");
  process.exit(1);
}

const target = resolve(path);
const partial = `${target}.partial`;
// A new month's file can be a few days late.
const now = new Date();
const months = [0, 1].map((back) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 7),
);

await mkdir(dirname(target), { recursive: true });
for (const month of months) {
  const url = `https://download.db-ip.com/free/dbip-${edition}-lite-${month}.mmdb.gz`;
  const response = await fetch(url);
  if (response.status === 404 && month !== months.at(-1)) continue;
  if (!response.ok || !response.body) {
    console.error(`${url}: HTTP ${response.status}`);
    process.exit(1);
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      createGunzip(),
      createWriteStream(partial),
    );
    // Whole or not at all: a running app may read it at any time.
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
  console.log(`${target}: DB-IP ${edition} Lite ${month}`);
  console.log("IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0");
  break;
}
