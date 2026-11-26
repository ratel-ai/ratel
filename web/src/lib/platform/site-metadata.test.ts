import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultLinkPreview, siteMetadata } from "@/lib/platform/site-metadata";

test("the root metadata carries upstream's link preview: OpenGraph and a large Twitter card", () => {
  const metadata = siteMetadata("Acme", {
    siteName: "Acme Cloud",
    title: "Acme Cloud: the card's headline",
    description: "What the card says.",
  });
  assert.deepEqual(metadata.title, { default: "Acme", template: "%s · Acme" });
  assert.equal(metadata.description, "What the card says.");
  assert.deepEqual(metadata.icons, { icon: "/icon.png" });
  assert.deepEqual(metadata.openGraph, {
    title: "Acme Cloud: the card's headline",
    description: "What the card says.",
    siteName: "Acme Cloud",
    type: "website",
  });
  assert.deepEqual(metadata.twitter, {
    card: "summary_large_image",
    title: "Acme Cloud: the card's headline",
    description: "What the card says.",
  });
});

test("the root metadata names no host: the origin is runtime config, and a preview takes the shared URL", () => {
  const metadata = siteMetadata("Acme", { siteName: "Acme", title: "Acme", description: "d" });
  assert.equal(metadata.metadataBase, undefined);
  assert.equal((metadata.openGraph as { url?: string }).url, undefined);
});

test("without an edition, the preview names this deployment", () => {
  assert.deepEqual(defaultLinkPreview("Ratel"), {
    siteName: "Ratel",
    title: "Ratel",
    description:
      "Ratel breaks down how your agent spends its input token budget across skills, tools, history, memory, and user input, then tells you what to reclaim.",
  });
});
