#!/usr/bin/env node
/**
 * Download the DB-IP IP-to-Country Lite database (mmdb) for the client geo
 * lookup (RC-774, lib/ingest/otlp/dimensions/geo.ts). CC BY 4.0, no account and no
 * key. DB-IP publishes one file per month; the current month's file can be
 * missing in the first days, so this falls back to the previous month.
 *
 *   node src/scripts/fetch-geo-db.mjs <out.mmdb> [YYYY-MM]
 *
 * The image build runs it (src/Dockerfile, the `geo` stage) with the month the
 * build passes in GEO_DB_MONTH, so each month's first build downloads the new
 * file. Plain Node, no dependency:
 * the build stage that runs it has no node_modules.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";

const URL_OF = (month) => `https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`;
/** Every mmdb file ends with its metadata, which starts with this marker. */
const METADATA_MARKER = Buffer.from("\xab\xcd\xefMaxMind.com", "latin1");
const MIN_BYTES = 1_000_000;

const [out, monthArg] = process.argv.slice(2);
if (!out) {
  console.error("usage: fetch-geo-db.mjs <out.mmdb> [YYYY-MM]");
  process.exit(2);
}

const month = /^\d{4}-\d{2}$/.test(monthArg ?? "")
  ? monthArg
  : new Date().toISOString().slice(0, 7);
for (const candidate of [month, previousMonth(month)]) {
  const res = await fetch(URL_OF(candidate));
  if (!res.ok) {
    console.error(`dbip-country-lite-${candidate}: HTTP ${res.status}`);
    continue;
  }
  const file = gunzipSync(Buffer.from(await res.arrayBuffer()));
  if (file.length < MIN_BYTES || file.lastIndexOf(METADATA_MARKER) < 0) {
    throw new Error(`dbip-country-lite-${candidate}: not an mmdb file (${file.length} bytes)`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, file);
  console.log(`dbip-country-lite-${candidate}: ${file.length} bytes -> ${out}`);
  process.exit(0);
}
throw new Error(`no DB-IP country file for ${month} or the month before`);

function previousMonth(value) {
  const [year, mon] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, mon - 2, 1));
  return date.toISOString().slice(0, 7);
}
