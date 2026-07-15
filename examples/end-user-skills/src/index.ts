import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { SkillCatalog, TraceSession } from "@ratel-ai/sdk";
import { CloudClient, type Suggestion } from "@ratel-ai/cloud";

/**
 * End-to-end demo: one opaque end-user's usage, captured by the Ratel SDK,
 * flows into Ratel Cloud for real (no mocks, no direct DB access — every step
 * below is a genuine HTTP call the SDK makes) and comes back out as a
 * per-user skill suggestion this script then approves or rejects, also
 * through the SDK.
 *
 *   1. Sync this project's published skills into a live SkillCatalog.
 *   2. Simulate the end-user's asks: one a published skill already covers
 *      (search + invoke, a real trace), one it doesn't (a coverage gap).
 *   3. Flush the trace-event exporter and force Cloud's categorization pass
 *      (`cloud.categorizeQueries()` — bypasses the ~hourly cron throttle).
 *   4. Ask Cloud to generate suggestions — with the demo's low occurrence
 *      threshold (see apps/cloud/.env.local), a single ask already qualifies.
 *   5. List the pending proposals scoped to this end-user, then approve or
 *      reject one through `cloud.suggestions`.
 *
 * Setup: see README.md (seed a project with `pnpm --filter @ratel/cloud
 * seed:end-user-demo`, then run this with the printed API key).
 */

interface Args {
  endUserId: string;
  action?: "approve" | "reject";
  occurrences: number;
  gapQuery: string;
  coveredQuery: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) flags.set(m[1], m[2]);
  }
  const action = flags.get("action");
  if (action && action !== "approve" && action !== "reject") {
    throw new Error(`--action must be "approve" or "reject", got "${action}"`);
  }
  return {
    endUserId: flags.get("user") ?? "demo-user-1",
    action: action as "approve" | "reject" | undefined,
    occurrences: Number(flags.get("occurrences") ?? "1"),
    gapQuery: flags.get("gap-query") ?? "draft a customer refund policy document",
    coveredQuery: flags.get("covered-query") ?? "write unit tests for my new function",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.RATEL_CLOUD_URL ?? "http://localhost:3000";
  const apiKey = process.env.RATEL_CLOUD_API_KEY;
  if (!apiKey) {
    console.error("Set RATEL_CLOUD_API_KEY (see README.md — seed:end-user-demo prints one).");
    process.exit(1);
  }

  console.log(`cloud: ${baseUrl}`);
  console.log(`end-user: ${args.endUserId}\n`);

  // One TraceSession per end-user (see CloudExporterOptions.endUserId doc —
  // there's no per-event override at this layer, so one process serving many
  // end-users would want one session+exporter pair per user).
  const session = new TraceSession({ sessionId: randomUUID(), harness: "end-user-skills-demo" });
  const skills = new SkillCatalog({ traceSession: session });

  const cloud = new CloudClient({ baseUrl, apiKey });

  // 1. Pull the project's published skills for real.
  const sync = await cloud.syncSkills(skills, { traceSession: session });
  console.log(`synced catalog: ${skills.size()} published skill(s)`);

  const exporter = cloud.createExporter(session, {
    endUserId: args.endUserId,
    flushIntervalMs: 5_000,
    onError: (err) => console.error("[exporter]", err.message),
    onRejected: (rejected) => console.error("[exporter] rejected:", rejected),
  });
  exporter.start();

  // 2a. A covered ask — searched, and (if matched) invoked, a real trace pair.
  const coveredHits = skills.searchTraced(args.coveredQuery, 3, "agent").hits;
  if (coveredHits.length > 0) {
    const top = skills.get(coveredHits[0].skillId);
    console.log(`covered ask "${args.coveredQuery}" -> matched "${top?.name}" (score ${coveredHits[0].score.toFixed(2)}), invoking`);
    skills.invoke(coveredHits[0].skillId);
  } else {
    console.log(`covered ask "${args.coveredQuery}" -> no match (is the catalog seeded? see README.md)`);
  }

  // 2b. A recurring, uncovered ask — the coverage gap. Same exact text each
  // time so Cloud's exact-match pass collapses it into one canonical intent.
  for (let i = 0; i < args.occurrences; i++) {
    skills.searchTraced(args.gapQuery, 3, "agent");
  }
  console.log(`uncovered ask "${args.gapQuery}" x${args.occurrences}`);

  // 3. Push the trace events to Cloud now (don't wait for the 5s timer).
  await exporter.flush();
  console.log("\nflushed trace events");

  // Force categorization now rather than waiting for the ~hourly cron cadence
  // — folds the search/skill_search events above into query_intents +
  // query_intent_occurrences.
  await cloud.categorizeQueries();
  console.log("categorized queries");

  // 4. Generate suggestions — signal detection + (with ANTHROPIC_API_KEY set
  // on Cloud) a real drafted skill for the coverage gap.
  const gen = await cloud.suggestions.generate();
  console.log(`generated suggestions (job ${gen.jobId}${gen.coalesced ? ", coalesced" : ""})`);

  // 5. Find the proposal(s) scoped to THIS end-user.
  const { suggestions } = await cloud.suggestions.list({ status: "pending", type: "new_skill" });
  const mine = suggestions.filter((s) => s.endUserId === args.endUserId);

  if (mine.length === 0) {
    console.log(
      "\nno pending per-user suggestion found for this end-user yet. If this is the first " +
        "run, check: ANTHROPIC_API_KEY set on Cloud, SUGGESTIONS_MIN_*_OCCURRENCES low enough " +
        "(apps/cloud/.env.local), and that --occurrences meets that threshold.",
    );
    await cleanup();
    return;
  }

  console.log(`\n${mine.length} pending suggestion(s) for "${args.endUserId}":`);
  for (const s of mine) await review(s);

  await cleanup();

  async function review(suggestion: Suggestion): Promise<void> {
    const patch = suggestion.patch as { name?: string; description?: string } | null;
    console.log(`\n— ${suggestion.id} (${suggestion.signalKind})`);
    console.log(`  rationale: ${suggestion.rationale}`);
    if (patch?.name) console.log(`  drafted skill: ${patch.name} — ${patch.description}`);

    const action = args.action ?? (await promptAction(suggestion.id));
    if (action === "approve") {
      const approved = await cloud.suggestions.approve(suggestion.id);
      console.log(`  -> approved (createdSkillId: ${approved.createdSkillId})`);
      console.log(
        "     note: a user-scoped skill lands as a draft in Cloud's DB but does NOT sync into " +
          "this SkillCatalog — GET /api/v1/catalog only ever serves global (end_user_id IS NULL) " +
          "skills today. That's a real, current boundary, not a bug in this demo.",
      );
    } else {
      const rejected = await cloud.suggestions.reject(suggestion.id);
      console.log(`  -> rejected (status: ${rejected.status})`);
    }
  }

  async function cleanup(): Promise<void> {
    sync.stop();
    await exporter.shutdown();
  }
}

async function promptAction(suggestionId: string): Promise<"approve" | "reject"> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question(`  approve or reject ${suggestionId}? [a/r] `)).trim().toLowerCase();
      if (answer === "a" || answer === "approve") return "approve";
      if (answer === "r" || answer === "reject") return "reject";
    }
  } finally {
    rl.close();
  }
}

await main();
