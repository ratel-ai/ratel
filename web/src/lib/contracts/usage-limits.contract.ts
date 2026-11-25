import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UsageLimitsPort, UsageLimitValues, UsageSubject } from "./usage-limits";

const SUBJECT: UsageSubject = {
  organizationId: "00000000-0000-4000-8000-0000000000a1",
  projectId: "00000000-0000-4000-8000-0000000000b1",
};

type Make = (limits: Partial<UsageLimitValues>) => UsageLimitsPort | Promise<UsageLimitsPort>;

/** What every adapter of the usage-limits port must do. Imported by the test of each adapter. */
export function usageLimitsContract(label: string, make: Make): void {
  describe(`usage limits contract: ${label}`, () => {
    test("a request within the limit passes, also when it reaches the limit", async () => {
      const limits = await make({ sandbox_runs_per_day: 3 });
      const check = (current: number, amount?: number) =>
        limits.check(SUBJECT, "sandbox_runs_per_day", { current, amount });
      assert.deepEqual(await check(0), { ok: true });
      assert.deepEqual(await check(2), { ok: true });
      assert.deepEqual(await check(0, 3), { ok: true });
    });

    test("a refusal has the limit name, the limit value and the present value", async () => {
      const limits = await make({ sandbox_runs_per_day: 3 });
      const refusal = await limits.check(SUBJECT, "sandbox_runs_per_day", { current: 3 });
      assert.ok(!refusal.ok);
      assert.equal(refusal.limit, "sandbox_runs_per_day");
      assert.equal(refusal.max, 3);
      assert.equal(refusal.current, 3);
      assert.match(refusal.message, /sandbox_runs_per_day.*3/);
    });

    test("an amount larger than what is left is refused", async () => {
      const limits = await make({ sandbox_bundle_bytes: 10 });
      const check = await limits.check(SUBJECT, "sandbox_bundle_bytes", { current: 0, amount: 11 });
      assert.equal(check.ok, false);
    });

    test("limit answers the value that check enforces", async () => {
      const limits = await make({ sandbox_run_seconds: 60 });
      assert.equal(await limits.limit(SUBJECT, "sandbox_run_seconds"), 60);
    });

    test("recording the same reference again is accepted", async () => {
      const limits = await make({});
      const usage = { kind: "sandbox_run", reference: "run-1" } as const;
      await limits.record(SUBJECT, usage);
      await limits.record(SUBJECT, usage);
    });
  });
}
