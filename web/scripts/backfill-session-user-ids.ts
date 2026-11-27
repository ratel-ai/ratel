#!/usr/bin/env tsx
/**
 * Fill `session_id` and `end_user_id` of the spans and trace summaries stored
 * before migration 0056 (`0056_session_user_ids`, RTL-321).
 *
 * Ingest and the summary sweep fill them for every row written after the
 * deploy. Stored span rows do not keep the session and user keys, so this reads
 * the values from `trace_events`, by trace id, in (project_id, trace_id)
 * batches.
 *
 * It is a dry run by default: it counts the rows it would fill and writes
 * nothing. Pass `--apply` to write. It writes only null columns, so it is safe
 * to re-run and to interrupt: a second run writes nothing. It does not move the
 * summary sweep cursor. It logs counts only.
 *
 * Usage:
 *   DATABASE_URL=… pnpm --filter @ratel/platform backfill:session-user-ids [--apply] [--project <id>] [--batch-size <n>]
 */

import "./load-env";
import { getDb } from "@/lib/platform/db/client";
import {
  backfillSessionUserIds,
  sessionUserBackfillOptionsFromArgs,
} from "@/lib/synthesis/traces/session-user-backfill";

async function main() {
  const options = sessionUserBackfillOptionsFromArgs(process.argv.slice(2));
  const { apply, projectId } = options;

  console.log(
    `${apply ? "Filling" : "Dry run (pass --apply to write): counting"} session and end-user ids of stored spans and trace summaries` +
      `${projectId ? ` of project ${projectId}` : ""}`,
  );
  const { traces, spans, summaries, batches } = await backfillSessionUserIds(getDb(), {
    ...options,
    onBatch: (progress) =>
      console.log(
        `… ${progress.spans} spans and ${progress.summaries} summaries in ${progress.traces} traces, ${progress.batches} batches`,
      ),
  });
  console.log(
    apply
      ? `✓ Session and end-user backfill complete: ${spans} spans and ${summaries} summaries filled in ${traces} traces, ${batches} batches.`
      : `✓ Session and end-user backfill dry run: ${spans} spans and ${summaries} summaries to fill in ${traces} traces, ${batches} batches. Nothing was written; pass --apply to write.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(
    `✗ Session and end-user backfill failed: ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
});
