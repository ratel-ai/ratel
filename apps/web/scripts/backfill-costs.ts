#!/usr/bin/env tsx
/**
 * Give a cost to stored model calls that have none, or restate the stored
 * costs at the prices of now (RC-482).
 *
 * Ingest prices each call once, with the prices of that moment. A call of a
 * model priced later (a new entry in `MODEL_PRICES`, or a project's own price)
 * keeps a null `cost_usd` on `otel_spans`, `events` and `event_metrics` until
 * this runs. By default it prices every such row whose model has a price now,
 * with the project's own prices first, exactly as ingest would. Calls of a
 * model with no price stay null.
 *
 * `--reprice` restates the rows that already have a cost instead, after a
 * price correction: each gets the cost of now, and a row whose model has no
 * price now loses its cost. `--dry-run` writes nothing and prints, for each
 * organization, model and table, the rows that would change and their old and
 * new cost totals. `--exclude-organization` (repeatable) leaves an
 * organization's projects alone. An id that names no organization fails the
 * run before it reads or writes a row.
 *
 * Both modes read a page of rows at a time and write only the rows whose cost
 * changes, or whose `event_metrics` cost differs from the event's, so a
 * re-run writes nothing. Each page writes `events` and `event_metrics` in one
 * transaction.
 *
 * Usage:
 *   DATABASE_URL=… pnpm --filter @ratel/platform backfill:costs [--project <project id>]
 *   DATABASE_URL=… pnpm --filter @ratel/platform backfill:costs --reprice [--dry-run]
 *     [--project <project id>] [--exclude-organization <organization id>]…
 */
import { parseArgs } from "node:util";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import {
  type CostChange,
  repriceStored,
  repriceUnpriced,
} from "@/lib/ingest/model-pricing/reprice";
import { getDb } from "@/lib/platform/db/client";

async function main() {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      reprice: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "exclude-organization": { type: "string", multiple: true, default: [] },
    },
  });
  const projectId = values.project;
  const scope = projectId ? ` in project ${projectId}` : "";
  const log = { info: (line: string) => console.log(line) };

  if (!values.reprice) {
    if (values["dry-run"] || values["exclude-organization"].length > 0) {
      throw new Error("--dry-run and --exclude-organization need --reprice");
    }
    const { spans, events } = await repriceUnpriced(getDb(), { projectId, log });
    console.log(`✓ Cost backfill complete: ${spans} spans and ${events} events priced${scope}.`);
    process.exit(0);
  }

  const dryRun = values["dry-run"];
  const { spans, events, changes } = await repriceStored(getDb(), {
    projectId,
    excludeOrganizationIds: values["exclude-organization"],
    dryRun,
    log,
  });
  printChanges(changes);
  const verb = dryRun ? "would change" : "changed";
  console.log(
    `✓ Re-price ${dryRun ? "dry run " : ""}complete: ${spans} spans and ${events} events ${verb}${scope}.`,
  );
  process.exit(0);
}

function printChanges(changes: readonly CostChange[]) {
  if (changes.length === 0) {
    console.log("No stored cost changes.");
    return;
  }
  console.table(
    changes.map((change) => ({
      organization: change.organizationSlug,
      organization_id: change.organizationId,
      model: change.model,
      table: change.table,
      rows: change.rows,
      unpriced_now: change.unpricedNow,
      old_usd: change.oldUsd.toFixed(6),
      new_usd: change.newUsd.toFixed(6),
      delta_usd: (change.newUsd - change.oldUsd).toFixed(6),
    })),
  );
}

main().catch((err) => {
  console.error(`✗ Cost backfill failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
