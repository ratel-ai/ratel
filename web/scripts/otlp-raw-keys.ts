#!/usr/bin/env tsx
/**
 * Print the attribute keys one project sends, from its stored raw OTLP bodies
 * (`otlp_raw_exports`, RC-406). Per instrumentation scope: span names, resource
 * keys, span attribute keys, span event names and log keys, each with a count.
 * It prints no attribute values. It only reads, in a read-only transaction.
 *
 * Usage:
 *   DATABASE_URL=… pnpm --filter @ratel/cloud otlp-raw:keys --project <id> --since <date> [--until <date>] [--json]
 */

import "./load-env";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { createKeyInventory, formatKeyInventory } from "@/lib/ingest/otlp-raw/inventory";
import { type OtlpRawExportBody, readOtlpRawExportPage } from "@/lib/ingest/otlp-raw/store";
import { getDb } from "@/lib/platform/db/client";

const PAGE_SIZE = 50;
const USAGE = "usage: otlp-raw:keys --project <id> --since <date> [--until <date>] [--json]";

async function main() {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const since = parseDate(values.since);
  const until = values.until === undefined ? undefined : parseDate(values.until);
  if (!values.project || !since || until === null) throw new Error(USAGE);

  const inventory = createKeyInventory();
  await getDb().transaction(
    async (tx) => {
      let after: OtlpRawExportBody | undefined;
      for (;;) {
        const page = await readOtlpRawExportPage(tx, {
          projectId: values.project!,
          since,
          until,
          after,
          limit: PAGE_SIZE,
        });
        for (const row of page) {
          inventory.add(row.signal, row.contentType, new Uint8Array(gunzipSync(row.body)));
        }
        if (page.length < PAGE_SIZE) break;
        after = page[page.length - 1];
      }
    },
    { accessMode: "read only" },
  );

  const result = inventory.result();
  console.log(values.json ? JSON.stringify(result, null, 2) : formatKeyInventory(result));
  process.exit(0);
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

main().catch((err) => {
  console.error(`✗ otlp-raw:keys failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
