import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { composition } from "@/lib/composition";
import LegacyEmbeddingsPage from "./page";

/** A stub component for an edition slot: it renders nothing. */
const Nothing = () => null;
const editionUi = composition.ui;
const databaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  composition.ui = editionUi;
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
});

test("the old /embeddings address is a 404 without the edition's embeddings page", async () => {
  composition.ui = undefined;
  await assert.rejects(
    LegacyEmbeddingsPage({ searchParams: Promise.resolve({}) }),
    (err: { digest?: string }) => String(err.digest).includes("404"),
  );
});

test("with the edition's page it redirects for good to the project's embeddings page", async () => {
  composition.ui = async () => ({
    RootProvider: Nothing,
    AccountMenuItems: Nothing,
    ProjectPages: { embeddings: { title: "Embeddings", Page: Nothing } },
  });
  await assert.rejects(
    LegacyEmbeddingsPage({ searchParams: Promise.resolve({ range: "7d" }) }),
    (err: { digest?: string }) => {
      const digest = String(err.digest);
      return (
        digest.includes("NEXT_REDIRECT") &&
        digest.includes("/project/_/models/embeddings?range=7d") &&
        digest.includes("308")
      );
    },
  );
});
