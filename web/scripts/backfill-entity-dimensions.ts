#!/usr/bin/env tsx
/**
 * Fill the entity dimension columns of spans stored before migration 0039
 * (`0039_entity_dimensions`, upstream 0106, RC-772): `agent_key`, `agent_source`,
 * `caller_agent_key`, `mcp_server`, `mcp_server_source` and `mcp_role` on
 * `otel_spans`. It does not fill `mcp_session_id`: stored rows do not keep it.
 *
 * Ingest fills them for every span stored after the deploy. This derives them
 * for the older spans from their stored rows, with the rules ingest uses, in
 * (project_id, trace_id) batches.
 *
 * It is a dry run by default: it counts the spans it would fill and writes
 * nothing. Pass `--apply` to write. It writes only spans that have no
 * dimension yet, so it is safe to re-run and to interrupt. It does not move
 * the trace summary sweep cursor. It logs counts only.
 *
 * Usage:
 *   DATABASE_URL=… pnpm --filter @ratel/platform backfill:entity-dimensions [--apply] [--project <id>] [--before <ISO time>] [--batch-size <n>]
 *
 * `--before` reads only spans received before that time. Use the 0039 deploy
 * time to skip the spans ingest already filled.
 */

import "./load-env";
import {
  backfillEntityDimensions,
  backfillOptionsFromArgs,
} from "@/lib/ingest/otlp/dimensions/backfill";
import { getDb } from "@/lib/platform/db/client";

async function main() {
  const options = backfillOptionsFromArgs(process.argv.slice(2));
  const { apply, projectId, before } = options;

  console.log(
    `${apply ? "Filling" : "Dry run (pass --apply to write): counting"} entity dimensions of stored spans` +
      `${projectId ? ` of project ${projectId}` : ""}${before ? ` received before ${before.toISOString()}` : ""}`,
  );
  const { traces, spans, batches } = await backfillEntityDimensions(getDb(), {
    ...options,
    onBatch: (progress) =>
      console.log(
        `… ${progress.spans} spans in ${progress.traces} traces, ${progress.batches} batches`,
      ),
  });
  console.log(
    apply
      ? `✓ Entity dimension backfill complete: ${spans} spans filled in ${traces} traces, ${batches} batches.`
      : `✓ Entity dimension backfill dry run: ${spans} spans to fill in ${traces} traces, ${batches} batches. Nothing was written; pass --apply to write.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`✗ Entity dimension backfill failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
