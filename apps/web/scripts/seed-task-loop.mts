/**
 * Seed the task loop demo with the production jobs, on a project the platform seed already
 * built: live scores over 14 UTC days, the task eval sets, two fix simulations and a shipment
 * dated eight days ago with its post-ship measure.
 *
 *   pnpm --filter @ratel/platform seed --drain 4
 *   pnpm --filter @ratel/platform seed:task-loop --project <id or slug> [--no-models]
 *
 *   --no-models   local stand-ins for the drafts and simulations (EVAL_GATE_MOCK_MODEL=1, the
 *                 model keys unset), and no live judging: nothing calls out
 *
 * Then start the app with RATEL_EXPERIMENTAL_FEATURES=1 to open the pages it prints.
 * Owned (ADR-0030): upstream's `scripts/seed-task-loop.mts`; the pipeline runs through the
 * platform seed's `--drain`, so this script only seeds the task loop. Refuses a database that
 * is not on this machine.
 */
import { assertLocalDatabase } from "@/lib/console/seed/local-database";
import { seedTaskLoop } from "@/lib/console/seed/task-loop";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";

const logger = getLogger("scripts/seed-task-loop");

async function main() {
  const argv = process.argv.slice(2);
  const ref = argv[argv.indexOf("--project") + 1];
  if (!argv.includes("--project") || !ref || ref.startsWith("--")) {
    throw new Error(
      "Usage: pnpm --filter @ratel/platform seed:task-loop --project <id or slug> [--no-models]",
    );
  }
  assertLocalDatabase("seed the task loop demo");
  process.env.FF_STAGE_SPINE = "true";
  process.env.FF_EVAL_GATE = "true";
  const noModels = argv.includes("--no-models");
  if (noModels) {
    process.env.EVAL_GATE_MOCK_MODEL = "1";
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete process.env[key];
  }
  await seedTaskLoop(getDb(), ref, {
    noModels,
    out: (line) => process.stdout.write(`${line}\n`),
  });
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error({ err }, "task loop seed failed");
    process.exit(1);
  });
