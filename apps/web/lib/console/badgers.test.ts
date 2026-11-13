import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getBadgerAssetSource } from "@/components/console/badgers/honeybadger-assets";
import {
  CelebrationBadger,
  ConstructionBadger,
  SearchingBadger,
  SleepingBadger,
  TangledBadger,
  WavingBadger,
} from "@/components/console/badgers/honeybadgers";

const POSE_COMPONENTS: Array<{
  pose: string;
  label: string;
  Component: ComponentType;
}> = [
  { pose: "searching", label: "Searching honey badger", Component: SearchingBadger },
  { pose: "tangled", label: "Tangled honey badger", Component: TangledBadger },
  { pose: "sleeping", label: "Sleeping honey badger", Component: SleepingBadger },
  {
    pose: "construction",
    label: "Honey badger under construction",
    Component: ConstructionBadger,
  },
  {
    pose: "celebration",
    label: "Celebrating honey badger",
    Component: CelebrationBadger,
  },
  { pose: "waving", label: "Waving honey badger", Component: WavingBadger },
];

test("a missing badger asset resolves to the fallback branch", () => {
  const publicDirectory = mkdtempSync(join(tmpdir(), "ratel-badgers-"));

  try {
    assert.equal(getBadgerAssetSource("searching", publicDirectory), null);
  } finally {
    rmSync(publicDirectory, { recursive: true });
  }
});

test("an installed badger asset resolves to its public browser source", () => {
  const publicDirectory = mkdtempSync(join(tmpdir(), "ratel-badgers-"));

  try {
    const badgersDirectory = join(publicDirectory, "badgers");
    mkdirSync(badgersDirectory);
    writeFileSync(join(badgersDirectory, "waving.png"), "placeholder");

    assert.equal(getBadgerAssetSource("waving", publicDirectory), "/badgers/waving.png");
  } finally {
    rmSync(publicDirectory, { recursive: true });
  }
});

test("a pose component renders a current-color silhouette when its asset is missing", () => {
  const publicDirectory = mkdtempSync(join(tmpdir(), "ratel-badgers-"));
  const previousDirectory = process.cwd();

  try {
    process.chdir(publicDirectory);
    const html = renderToStaticMarkup(createElement(SearchingBadger));

    assert.doesNotMatch(html, /<img/);
    assert.match(html, /<svg[^>]*fill="currentColor"/);
    assert.match(html, /aria-label="Searching honey badger"/);
  } finally {
    process.chdir(previousDirectory);
    rmSync(publicDirectory, { recursive: true });
  }
});

test("a pose component renders its public image when the asset exists", () => {
  const appDirectory = mkdtempSync(join(tmpdir(), "ratel-badgers-"));
  const previousDirectory = process.cwd();

  try {
    const badgersDirectory = join(appDirectory, "public", "badgers");
    mkdirSync(badgersDirectory, { recursive: true });
    writeFileSync(join(badgersDirectory, "searching.png"), "placeholder");
    process.chdir(appDirectory);

    const html = renderToStaticMarkup(createElement(SearchingBadger));

    assert.match(html, /<img[^>]*src="\/badgers\/searching\.png"/);
    assert.match(html, /alt="Searching honey badger"/);
    assert.doesNotMatch(html, /role="img"/);
  } finally {
    process.chdir(previousDirectory);
    rmSync(appDirectory, { recursive: true });
  }
});

test("a pose component finds drop-in art from the standalone Docker app root", () => {
  const appDirectory = mkdtempSync(join(tmpdir(), "ratel-badgers-"));
  const previousDirectory = process.cwd();

  try {
    const badgersDirectory = join(appDirectory, "apps", "web", "public", "badgers");
    mkdirSync(badgersDirectory, { recursive: true });
    writeFileSync(join(badgersDirectory, "searching.png"), "placeholder");
    process.chdir(appDirectory);

    const html = renderToStaticMarkup(createElement(SearchingBadger));

    assert.match(html, /<img[^>]*src="\/badgers\/searching\.png"/);
  } finally {
    process.chdir(previousDirectory);
    rmSync(appDirectory, { recursive: true });
  }
});

test("every named pose switches from fallback to its exact drop-in asset", () => {
  const appDirectory = mkdtempSync(join(tmpdir(), "ratel-badgers-"));
  const badgersDirectory = join(appDirectory, "public", "badgers");
  const previousDirectory = process.cwd();

  try {
    mkdirSync(badgersDirectory, { recursive: true });
    process.chdir(appDirectory);

    for (const { pose, label, Component } of POSE_COMPONENTS) {
      const fallbackHtml = renderToStaticMarkup(createElement(Component));
      assert.doesNotMatch(fallbackHtml, /<img/, `${pose} falls back before art lands`);
      assert.match(fallbackHtml, new RegExp(`aria-label="${label}"`));

      writeFileSync(join(badgersDirectory, `${pose}.png`), "placeholder");
      const assetHtml = renderToStaticMarkup(createElement(Component));
      assert.ok(
        assetHtml.includes(`src="/badgers/${pose}.png"`),
        `${pose} uses its exact public URL after art lands`,
      );
    }
  } finally {
    process.chdir(previousDirectory);
    rmSync(appDirectory, { recursive: true });
  }
});
