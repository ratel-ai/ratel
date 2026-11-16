/**
 * Re-measure every fix's eval gate on a local database (RC-61): one fresh
 * simulation per fix that has an eval set, printed as a per-kind table.
 *
 *   DATABASE_URL=postgres://... pnpm --filter @ratel/cloud exec tsx scripts/eval-gate-measure.mts \
 *     --project <id|slug> [--fresh] [--fix <fix id>] [--json <file>]
 *
 * `--fresh` deletes each fix's eval set first, so the runs are picked again
 * (holdout first); without it the person's edited sets are re-simulated as
 * they are. Behavioral fixes are replayed whenever a model is configured, as
 * under `cloud-eval-gate` (the script itself reads no flag). Models: the key in the environment (`ANTHROPIC_API_KEY`, also read
 * from `.env.local` like the app), `EVAL_GATE_MOCK_MODEL=1` for the local
 * stand-ins, none otherwise; caps from `EVAL_GATE_*`. Refuses a database that
 * is not on this machine. Prints numbers and ids, never run text.
 */
import { writeFileSync } from "node:fs";
import { config } from "dotenv";
import { and, eq, or } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { fixEvalSets } from "@/lib/views/eval-gate/schema";
import { projects } from "@/lib/platform/projects/schema";
import { runSimulation } from "@/lib/views/eval-gate/service";
import { percent } from "@/lib/views/eval-gate/view";
import { assertLocalDatabase } from "@/lib/console/seed/local-database";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  assertLocalDatabase("re-measure eval gates");
  const db = getDb();
  const wanted = arg("project");
  if (!wanted) throw new Error("--project <id|slug> is required");
  const uuid = /^[0-9a-f-]{36}$/i.test(wanted);
  const [project] = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(uuid ? or(eq(projects.id, wanted), eq(projects.slug, wanted)) : eq(projects.slug, wanted))
    .limit(1);
  if (!project) throw new Error(`no project ${wanted}`);
  const only = arg("fix");
  const sets = await db
    .select({ fixId: fixEvalSets.fixId, kind: fixEvalSets.fixKind, title: fixEvalSets.title })
    .from(fixEvalSets)
    .where(only ? and(eq(fixEvalSets.projectId, project.id), eq(fixEvalSets.fixId, only)) : eq(fixEvalSets.projectId, project.id));
  console.log(`project ${project.slug}: ${sets.length} eval sets; fresh ${flag("fresh") ? "yes" : "no"}; key ${process.env.ANTHROPIC_API_KEY ? "set" : "unset"}; stand-ins ${process.env.EVAL_GATE_MOCK_MODEL === "1" ? "on" : "off"}`);
  const rows: Record<string, unknown>[] = [];
  for (const set of sets.sort((a, b) => a.kind.localeCompare(b.kind))) {
    if (flag("fresh")) await db.delete(fixEvalSets).where(and(eq(fixEvalSets.projectId, project.id), eq(fixEvalSets.fixId, set.fixId)));
    const started = Date.now();
    try {
      const outcome = await runSimulation(set.fixId, { projectId: project.id, trigger: "manual", actor: "system:eval-gate-measure" });
      const row = {
        kind: set.kind,
        fix: set.fixId,
        runs: outcome.nSimulated,
        of: outcome.nCases,
        before: percent(outcome.before?.passRate ?? null),
        after: percent(outcome.after?.passRate ?? null),
        verdict: outcome.verdict,
        rerank: outcome.methods?.rerank ?? 0,
        replay: outcome.methods?.replay ?? 0,
        cant: outcome.methods?.none ?? 0,
        why: outcome.methods?.reasons.map((reason) => `${reason.note} (${reason.runs})`).join("; ") ?? "",
        fidelity: outcome.methods?.fidelity ? `${outcome.methods.fidelity.matched}/${outcome.methods.fidelity.total}` : "",
        evidence: outcome.evidence ? `${percent(outcome.evidence.before.passRate)} → ${percent(outcome.evidence.after.passRate)} on ${outcome.evidence.nSimulated}` : "",
        usd: outcome.spend ? Number(outcome.spend.usd.toFixed(4)) : 0,
        calls: outcome.spend?.calls ?? 0,
        models: outcome.spend?.models.join(",") ?? "",
        seconds: Math.round((Date.now() - started) / 1000),
        error: outcome.error,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    } catch (err) {
      console.log(JSON.stringify({ kind: set.kind, fix: set.fixId, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  const out = arg("json");
  if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
