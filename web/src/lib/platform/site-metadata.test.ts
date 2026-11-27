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

test("an origin written without a scheme is read as https, and one that does not parse drops the origin, not the page", () => {
  const bare = siteMetadata("Acme", {
    origin: "app.example.com",
    siteName: "Acme",
    title: "Acme",
    description: "d",
  });
  assert.equal(String(bare.metadataBase), "https://app.example.com/");
  assert.equal((bare.openGraph as { url?: string }).url, "https://app.example.com");
  const broken = siteMetadata("Acme", {
    origin: "http://exa mple",
    siteName: "Acme",
    title: "Acme",
    description: "d",
  });
  assert.equal(broken.metadataBase, undefined);
  assert.equal((broken.openGraph as { url?: string }).url, undefined);
});

test("a preview with an image puts it on the OpenGraph and the Twitter card", () => {
  const metadata = siteMetadata("Acme", {
    origin: "https://app.example.com",
    siteName: "Acme",
    title: "Acme",
    description: "d",
    image: "/og.png",
  });
  assert.deepEqual((metadata.openGraph as { images?: unknown }).images, ["/og.png"]);
  assert.deepEqual((metadata.twitter as { images?: unknown }).images, ["/og.png"]);
});

test("without an edition, the preview names this deployment and shows the social card", () => {
  assert.deepEqual(defaultLinkPreview("Ratel", "http://localhost:3000"), {
    origin: "http://localhost:3000",
    siteName: "Ratel",
    title: "Ratel",
    description:
      "Ratel finds problems, fixes them and runs evals on your agent, for higher accuracy, lower latency and no wasted tokens, turn after turn.",
    image: "/og.png",
  });
});
