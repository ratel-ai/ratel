import { runDrainTick } from "@/lib/jobs/drain";
import type { BackgroundObservabilityDeps } from "@/lib/jobs/observability";
import { snapshotStep, sweepStep } from "@/lib/synthesis/quality/register";
import { parity } from "./ledger";
import { calledBy } from "./source-probes";
import { golden, ossTree, same } from "./support";

// Items 2 and 26: the drain. Cloud's drain is one function with injected steps; here the steps are
// registrations. The heartbeat's keys are the vocabulary both share, so the quality steps are run
// with the results Cloud's were given and the keys they report under are compared. The retention
// prunes need a database to run, so item 2 reads which of them the registrations call.

interface CloudDrain {
  sentinels: {
    refreshQualitySnapshots: Record<string, unknown>;
    sweepMatchQuality: Record<string, unknown>;
  };
  retentionOnly: string[];
  retentionOnlyCalledByDrain: string[];
  qualityHeartbeat: Record<string, number>;
}
const cloud = golden<CloudDrain>("drain");

parity(2, "every retention prune Cloud's drain calls is called by a registered step", () => {
  same(
    calledBy(ossTree.read("lib/cron/drain.ts"), cloud.retentionOnly),
    cloud.retentionOnlyCalledByDrain,
  );
});

parity(26, "the quality steps report under Cloud's heartbeat keys", async () => {
  const heartbeats: Record<string, unknown>[] = [];
  const track = async () => {};
  const observability: BackgroundObservabilityDeps = {
    trackServerEvent: async (event, _context, properties) => {
      if (event === "cron_drain_completed") heartbeats.push(properties ?? {});
    },
    reportServerException: () => {},
    now: () => 0,
    logError: () => {},
  };
  await runDrainTick({
    steps: [
      snapshotStep(async () => cloud.sentinels.refreshQualitySnapshots as never, track),
      sweepStep(async () => cloud.sentinels.sweepMatchQuality as never, track),
    ],
    drainProjectJobs: async () => ({ done: 0, failed: 0 }),
    retentionEnabled: true,
    observability,
  });
  const reported = new Set(
    Object.values(cloud.sentinels).flatMap((result) => Object.values(result)),
  );
  const quality = Object.fromEntries(
    Object.entries(heartbeats[0] ?? {}).filter(
      ([, value]) => typeof value === "number" && reported.has(value),
    ),
  );
  same(quality, cloud.qualityHeartbeat);
});
