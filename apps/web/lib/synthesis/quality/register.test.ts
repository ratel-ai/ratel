import assert from "node:assert/strict";
import { test } from "node:test";
import { IDLE_MATCH_QUALITY_SWEEP } from "@/lib/readings/match-quality/sweep";
import { IDLE_QUALITY_SNAPSHOT } from "@/lib/synthesis/quality/snapshot";
import { matchQualityRunJob, qualityRegistration, snapshotStep, sweepStep } from "./register";

test("quality registers the run job and two after-steps under upstream's names", () => {
  assert.deepEqual(Object.keys(qualityRegistration.jobs ?? {}), ["match_quality_run"]);
  assert.deepEqual(
    (qualityRegistration.drainSteps ?? []).map((s) => [s.name, s.phase]),
    [
      ["quality_snapshot_refresh", "after"],
      ["match_quality_sweep", "after"],
    ],
  );
});

test("a run whose payload no longer parses reports it instead of throwing", async () => {
  const result = await matchQualityRunJob({
    id: "j",
    projectId: "p",
    kind: "match_quality_run",
    payload: { nope: true },
  });
  assert.deepEqual(result, { proposalsCreated: 0, reason: "invalid_payload" });
});

test("an idle step emits no event; one that did work emits its event once", async () => {
  const events: string[] = [];
  const track = async (name: string) => {
    events.push(name);
  };
  await snapshotStep(async () => IDLE_QUALITY_SNAPSHOT, track as never).run();
  await sweepStep(async () => IDLE_MATCH_QUALITY_SWEEP, track as never).run();
  assert.deepEqual(events, []);
  await snapshotStep(
    async () => ({ ...IDLE_QUALITY_SNAPSHOT, skipped: false }),
    track as never,
  ).run();
  await sweepStep(
    async () => ({ ...IDLE_MATCH_QUALITY_SWEEP, skipped: false }),
    track as never,
  ).run();
  assert.deepEqual(events, ["quality_snapshots_refreshed", "match_quality_runs_enqueued"]);
});
