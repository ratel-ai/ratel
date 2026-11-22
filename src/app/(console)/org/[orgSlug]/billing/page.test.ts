import assert from "node:assert/strict";
import { test } from "node:test";
import OrganizationBillingRoute from "./page";

test("the billing route is a 404 without the edition's slot", async () => {
  await assert.rejects(
    OrganizationBillingRoute({
      params: Promise.resolve({ orgSlug: "acme" }),
      searchParams: Promise.resolve({}),
    }),
    (err: { digest?: string }) => String(err.digest).includes("404"),
  );
});
