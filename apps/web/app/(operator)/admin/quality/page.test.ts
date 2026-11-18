import assert from "node:assert/strict";
import { test } from "node:test";
import AdminQualityPage from "./page";

test("the operator Quality index is a 404 without the edition's operator console", async () => {
  await assert.rejects(
    AdminQualityPage({ searchParams: Promise.resolve({}) }),
    (err: { digest?: string }) => String(err.digest).includes("404"),
  );
});
