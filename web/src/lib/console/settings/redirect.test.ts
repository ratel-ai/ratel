import assert from "node:assert/strict";
import { test } from "node:test";
import { isRedirectError, settleRedirectingAction } from "@/lib/console/settings/redirect";

const REDIRECT = Object.assign(new Error("NEXT_REDIRECT"), {
  digest: "NEXT_REDIRECT;push;/project/p2/dashboards;307;",
});

test("only a Next redirect passes through as a navigation; anything else is a failure", () => {
  assert.equal(
    isRedirectError({ digest: "NEXT_REDIRECT;replace;https://pay.example.com/x;307;" }),
    true,
  );
  assert.equal(isRedirectError({ digest: "NEXT_NOT_FOUND" }), false);
  assert.equal(isRedirectError(new Error("boom")), false);
  assert.equal(isRedirectError(null), false);
  assert.equal(isRedirectError("NEXT_REDIRECT"), false);
});

test("a delete that redirects succeeded; a refusal comes back as its message", async () => {
  assert.deepEqual(
    await settleRedirectingAction(async () => {
      throw REDIRECT;
    }),
    { navigated: true },
  );
  assert.deepEqual(
    await settleRedirectingAction(async () => ({
      ok: false,
      error: "The name you typed doesn't match this project.",
    })),
    { navigated: false, error: "The name you typed doesn't match this project." },
  );
  assert.deepEqual(await settleRedirectingAction(async () => undefined), {
    navigated: false,
    error: null,
  });
});

test("any other failure reaches the caller's own failure path", async () => {
  await assert.rejects(
    settleRedirectingAction(async () => {
      throw new Error("network down");
    }),
    /network down/,
  );
});
