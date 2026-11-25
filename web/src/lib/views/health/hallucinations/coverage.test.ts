import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedExists } from "@/lib/views/health/hallucinations/page-queries";

/** Runs the read as given, in place of the statement timeout's transaction. */
const direct = <T>(read: (db: never) => Promise<T>) => read(undefined as never);

test("a coverage probe says whether a row exists, under a statement timeout", async () => {
  let bounded = 0;
  const counting = <T>(read: (db: never) => Promise<T>, options: { operation: string }) => {
    bounded += 1;
    assert.equal(options.operation, "hallucinations_coverage_error_text");
    return direct(read);
  };
  assert.equal(
    await boundedExists("hallucinations_coverage_error_text", async () => [{ one: 1 }], counting),
    true,
  );
  assert.equal(
    await boundedExists("hallucinations_coverage_error_text", async () => [], counting),
    false,
  );
  assert.equal(bounded, 2, "every probe runs bounded");
});

test("a probe that runs out of time reads as no: a scan that found nothing early has nothing to find", async () => {
  const timedOut = async () => {
    throw new Error("canceling statement due to statement timeout");
  };
  assert.equal(await boundedExists("hallucinations_coverage_requested", timedOut, direct), false);
});
