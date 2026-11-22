import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { shipmentCommitsFor } from "@/components/console/code-handoff/deploy/opened-shipment-commits";
import { shipmentCommitsView } from "@/lib/views/code-handoff/deploy/shipment-commits";
import type { RepoCommitRow } from "@/lib/views/code-handoff/schema";

/** Ship's commits next to a GitHub shipment (RC-921). */

const SHIPMENT = "33333333-3333-4333-8333-333333333333";

function commit(
  seq: number,
  sha: string,
  message: string,
  shipmentIds: string[] = [],
): RepoCommitRow {
  return {
    id: `c${seq}`,
    repoLinkId: "link-1",
    sha,
    messageHead: message,
    authorLogin: "ana",
    pushedAt: new Date("2026-11-18T10:00:00Z"),
    seq,
    fixIds: [],
    shipmentIds,
    deployedAt: null,
  };
}

const CARRIER = commit(2, "0123456789abcdef0123456789abcdef01234567", "Tighten the search tool", [
  SHIPMENT,
]);
const VIEW = shipmentCommitsView(
  { owner: "acme", name: "agent" },
  SHIPMENT,
  [CARRIER],
  [CARRIER, commit(1, "a".repeat(40), "Earlier work")],
);

test("a GitHub shipment shows its commits, newest first, each linked to github.com, the carrier marked", async () => {
  const html = renderToStaticMarkup(
    await shipmentCommitsFor("p1", SHIPMENT, { load: async () => VIEW }),
  );
  assert.match(
    html,
    /href="https:\/\/github\.com\/acme\/agent\/commit\/0123456789abcdef0123456789abcdef01234567"/,
  );
  assert.match(html, />0123456</);
  assert.match(html, /Tighten the search tool/);
  assert.match(html, /ana · /);
  assert.equal((html.match(/data-carried="true"/g) ?? []).length, 1);
  assert.equal((html.match(/Carried the fix/g) ?? []).length, 1);
  assert.ok(html.indexOf("Tighten the search tool") < html.indexOf("Earlier work"), "newest first");
  assert.match(html, /href="https:\/\/github\.com\/acme\/agent"/);
});

test("a manual shipment (no commit carried it) renders nothing extra", async () => {
  const node = await shipmentCommitsFor("p1", SHIPMENT, { load: async () => null });
  assert.equal(node, null);
});

test("the view keeps each commit once and only marks the carriers", () => {
  assert.deepEqual(
    VIEW.commits.map((row) => [row.shortSha, row.carried]),
    [
      ["0123456", true],
      ["aaaaaaa", false],
    ],
  );
});
