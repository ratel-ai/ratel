import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement } from "react";
import { composition } from "@/lib/composition";
import type { EditionUi } from "@/lib/contracts/composition";
import CompactionPage from "../compaction/page";
import EditionProjectRoute, { generateMetadata } from "./page";

const params = (page: string) => Promise.resolve({ projectId: "p1", page });
const is404 = (err: { digest?: string }) => String(err.digest).includes("404");

function Embeddings() {
  return null;
}

async function withUi(ui: Partial<EditionUi>, run: () => Promise<void>) {
  const saved = composition.ui;
  composition.ui = async () => ({ RootProvider: () => null, AccountMenuItems: () => null, ...ui });
  try {
    await run();
  } finally {
    composition.ui = saved;
  }
}

test("a project page is a 404 without the edition's slot", async () => {
  await assert.rejects(EditionProjectRoute({ params: params("embeddings") }), is404);
});

test("the edition's page renders at its key, with its title; any other key is a 404", async () => {
  await withUi(
    { ProjectPages: { embeddings: { title: "Embeddings", Page: Embeddings } } },
    async () => {
      const element = await EditionProjectRoute({ params: params("embeddings") });
      assert.ok(isValidElement(element));
      assert.equal(element.type, Embeddings);
      assert.deepEqual(element.props, { projectId: "p1" });
      assert.deepEqual(await generateMetadata({ params: params("embeddings") }), {
        title: "Embeddings",
      });
      await assert.rejects(EditionProjectRoute({ params: params("tool-picker") }), is404);
      await assert.rejects(EditionProjectRoute({ params: params("constructor") }), is404);
    },
  );
});

test("compaction keeps its own route: a redirect to the context split", async () => {
  await assert.rejects(
    CompactionPage({ params: Promise.resolve({ projectId: "p1" }) }),
    (err: { digest?: string }) => String(err.digest).includes("/project/p1?peek=context"),
  );
});
