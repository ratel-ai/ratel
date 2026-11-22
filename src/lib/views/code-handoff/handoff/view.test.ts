import assert from "node:assert/strict";
import { test } from "node:test";
import type { FixHandoffRow, RepoLinkRow } from "@/lib/views/code-handoff/schema";
import { type HandoffButtonDeps, loadHandoffButtonState } from "./view";

const LINK = { id: "link-1" } as RepoLinkRow;
const ROW = { url: "https://github.com/acme/agent/issues/1" } as FixHandoffRow;

const deps = (over: Partial<HandoffButtonDeps> = {}): HandoffButtonDeps => ({
  flagEnabled: async () => true,
  getRepoLink: async () => LINK,
  getHandoff: async () => null,
  ...over,
});

test("flag off: no button", async () => {
  assert.equal(
    await loadHandoffButtonState("p1", "craft:a", deps({ flagEnabled: async () => false })),
    null,
  );
});

test("flag on without a linked repo: the button links to Settings › Repository", async () => {
  const state = await loadHandoffButtonState(
    "p1",
    "craft:a",
    deps({ getRepoLink: async () => null }),
  );
  assert.deepEqual(state, {
    linked: false,
    settingsHref: "/project/p1/settings/repository",
    issueUrl: null,
  });
});

test("flag on with a repo: the button, then the issue once handed off", async () => {
  assert.equal((await loadHandoffButtonState("p1", "craft:a", deps()))?.issueUrl, null);
  assert.equal(
    (await loadHandoffButtonState("p1", "craft:a", deps({ getHandoff: async () => ROW })))
      ?.issueUrl,
    ROW.url,
  );
});
