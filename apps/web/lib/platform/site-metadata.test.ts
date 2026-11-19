import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultLinkPreview, siteMetadata } from "@/lib/platform/site-metadata";

test("the root metadata carries upstream's link preview: metadataBase, OpenGraph and a large Twitter card", () => {
  const metadata = siteMetadata("Acme", {
    origin: "https://app.example.com",
    siteName: "Acme Cloud",
    title: "Acme Cloud: the card's headline",
    description: "What the card says.",
  });
  assert.equal(String(metadata.metadataBase), "https://app.example.com/");
  assert.deepEqual(metadata.title, { default: "Acme", template: "%s · Acme" });
  assert.equal(metadata.description, "What the card says.");
  assert.deepEqual(metadata.icons, { icon: "/icon.png" });
  assert.deepEqual(metadata.openGraph, {
    title: "Acme Cloud: the card's headline",
    description: "What the card says.",
    url: "https://app.example.com",
    siteName: "Acme Cloud",
    type: "website",
  });
  assert.deepEqual(metadata.twitter, {
    card: "summary_large_image",
    title: "Acme Cloud: the card's headline",
    description: "What the card says.",
  });
});

test("without an edition, the preview names this deployment", () => {
  assert.deepEqual(defaultLinkPreview("Ratel", "http://localhost:3000"), {
    origin: "http://localhost:3000",
    siteName: "Ratel",
    title: "Ratel",
    description:
      "Ratel breaks down how your agent spends its input token budget across skills, tools, history, memory, and user input, then tells you what to reclaim.",
  });
});
