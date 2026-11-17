#!/usr/bin/env tsx
/**
 * Re-run today's span-to-event mapping over one project's stored raw OTLP
 * trace exports (`otlp_raw_exports`) and patch the `events` and
 * `event_metrics` rows they derive (usage, cost, payload, categorize). The ingest
 * switches are decided as `/v1/traces` decides them, and printed first.
 *
 * Owned (ADR-0030): upstream decides its ingest flags through its flag service and aborts when it
 * cannot; here they are the deployment's switches, which always answer.
 *
 * A dry run by default: it reads in a read-only transaction and prints how many
 * events would change, with the before/after input, cached and cost totals.
 * `--apply` writes one transaction per batch of exports. A second `--apply`
 * changes nothing.
 *
 * Usage:
 *   DATABASE_URL=… pnpm --filter @ratel/platform otlp-raw:reprocess --project <id> --since <date> [--until <date>] [--apply] [--json]
 */
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

import { parseArgs } from "node:util";
import { loadPriceOverrides } from "@/lib/ingest/model-pricing/store";
import { findTracesWithModelCalls } from "@/lib/ingest/otlp/queries";
import {
  type ReprocessIngestFlags,
  type ReprocessReport,
  reprocessOtlpRawExports,
  type UsageTotals,
} from "@/lib/ingest/otlp-raw/reprocess";
import { decideReprocessFlags } from "@/lib/ingest/otlp-raw/reprocess-flags";
import {
  applyReprocessPlan,
  findStoredEvents,
  type ReprocessDb,
} from "@/lib/ingest/otlp-raw/reprocess-store";
import { readOtlpRawExportPage } from "@/lib/ingest/otlp-raw/store";
import { getDb } from "@/lib/platform/db/client";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";

const USAGE =
  "usage: otlp-raw:reprocess --project <id> --since <date> [--until <date>] [--apply] [--json]";

async function main() {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      apply: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const since = parseDate(values.since);
  const until = values.until === undefined ? undefined : parseDate(values.until);
  if (!values.project || !since || until === null) throw new Error(USAGE);
  const projectId = values.project;
  const apply = values.apply;

  const organization = await getOrganizationByProjectId(projectId);
  if (!organization) throw new Error(`no project ${projectId}`);
  const decided = await decideReprocessFlags(projectId, organization);
  for (const { flag, enabled, source } of decided.decisions) {
    console.error(
      `flag ${flag} = ${enabled ? "on" : "off"} from ${source}, organization ${organization.id}`,
    );
  }
  const db = getDb();
  const flags: ReprocessIngestFlags = {
    ...decided.flags,
    agentSpanDedupe: {
      findTracesWithModelCalls: (id, traceIds) => findTracesWithModelCalls(id, traceIds),
    },
    prices: { overrides: await loadPriceOverrides(projectId, db) },
  };

  const run = (tx: ReprocessDb, flags: ReprocessIngestFlags) =>
    reprocessOtlpRawExports(
      { projectId, since, until, apply },
      {
        flags,
        readPage: (after, limit) =>
          readOtlpRawExportPage(tx, { projectId, since, until, after, limit }),
        findStoredEvents: (keys) => findStoredEvents(tx, projectId, keys),
        applyPlan: (plan) => applyReprocessPlan(tx, projectId, plan),
        onBatch: (report) => {
          if (!values.json)
            console.error(`… ${report.exports} exports, ${report.rebuiltEvents} events`);
        },
      },
    );

  const report = apply
    ? await run(db, flags)
    : await db.transaction((tx) => run(tx as unknown as ReprocessDb, flags), {
        accessMode: "read only",
      });

  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(projectId, report));
  process.exit(0);
}

function formatReport(projectId: string, r: ReprocessReport): string {
  const verb = r.applied ? "changed" : "would change";
  return [
    `${r.applied ? "APPLY" : "DRY RUN"} otlp-raw:reprocess project ${projectId}`,
    `exports read      ${r.exports} (${r.skippedLogExports} log, ${r.undecodableExports} undecodable)`,
    `spans             ${r.spans}`,
    `events rebuilt    ${r.rebuiltEvents}`,
    `  unchanged       ${r.unchangedEvents}`,
    `  ${verb.padEnd(15)} ${r.changedEvents}`,
    `  ${(r.applied ? "inserted" : "would insert").padEnd(15)} ${r.newEvents}`,
    `  other trace     ${r.conflictingEvents} (dedupe hash held by another trace's row, left as is)`,
    `changed events    before → after`,
    `  input tokens    ${totals(r.before, r.after, "inputTokens")}`,
    `  cached tokens   ${totals(r.before, r.after, "cachedTokens")}`,
    `  cost usd        ${r.before.costUsd.toFixed(6)} → ${r.after.costUsd.toFixed(6)}`,
    `new events        input ${r.inserted.inputTokens} · cached ${r.inserted.cachedTokens} · cost ${r.inserted.costUsd.toFixed(6)}`,
  ].join("\n");
}

function totals(
  before: UsageTotals,
  after: UsageTotals,
  key: "inputTokens" | "cachedTokens",
): string {
  return `${before[key]} → ${after[key]}`;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

main().catch((err) => {
  console.error(`✗ otlp-raw:reprocess failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
