import assert from "node:assert/strict";
import { test } from "node:test";
import { isLinkPreviewAgent } from "@/lib/views/health/share-preview";

test("link unfurlers and crawlers are not people opening a shared page", () => {
  for (const agent of [
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "facebookexternalhit/1.1",
    "Mozilla/5.0 (compatible; Googlebot/2.1)",
    "WhatsApp/2.23.20",
    "Mozilla/5.0 (compatible; Discordbot/2.0)",
  ]) {
    assert.equal(isLinkPreviewAgent(agent), true, agent);
  }
});

test("a browser is a view, and so is a request that names no agent", () => {
  assert.equal(
    isLinkPreviewAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    ),
    false,
  );
  assert.equal(isLinkPreviewAgent(null), false);
});
