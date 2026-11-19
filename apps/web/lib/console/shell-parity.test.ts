import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar } from "@/components/console/shell/AccountMenu";
import { MAIN_CLASS_NAME, mobileTitle } from "@/components/console/shell/AppFrame";
import { commandPaletteUsed, commandSearchLabel } from "@/components/console/shell/CommandMenu";
import { ShellSkeleton } from "@/components/console/shell/ShellSkeleton";
import { railLandmark } from "@/components/console/shell/Sidebar";

/** The console shell as upstream's (components/shell, app/(app)/layout.tsx at 5f4cb8e0). */

const APP = join(dirname(fileURLToPath(import.meta.url)), "../../app/(console)");

test("choosing in ⌘K reports command_palette_used as upstream's CommandMenu", () => {
  assert.deepEqual(commandPaletteUsed({ href: "/project/p/traces" }, "trac", 2, "keyboard"), {
    destination: "/project/p/traces",
    query_length: 4,
    result_position: 2,
    trigger: "keyboard",
  });
  assert.deepEqual(
    commandPaletteUsed({ id: "shortcuts", href: "", run: () => {} }, "", 0, "pointer"),
    { destination: "action:shortcuts", query_length: 0, result_position: 0, trigger: "pointer" },
  );
});

test("⌘K says what it searches: upstream's pages and actions with the edition's switcher, pages and projects in open source", () => {
  assert.equal(commandSearchLabel(true), "Search pages and actions");
  assert.equal(commandSearchLabel(false), "Search pages and projects");
});

test("the organization rail's landmark is Organization, a project's Project", () => {
  assert.equal(railLandmark(true), "Project");
  assert.equal(railLandmark(false), "Organization");
});

test("the mobile bar falls back to the edition's product name", () => {
  assert.equal(mobileTitle(undefined, null, "Ratel Cloud"), "Ratel Cloud");
  assert.equal(mobileTitle(undefined, null, "Ratel"), "Ratel");
  assert.equal(mobileTitle(undefined, "Acme", "Ratel"), "Acme");
  assert.equal(mobileTitle({ name: "Bot" }, "Acme", "Ratel"), "Bot");
});

test("main becomes a flex column around a design-system page, so Page fills the viewport", () => {
  for (const name of [
    "has-[>[data-page]]:flex",
    "has-[>[data-page]]:flex-col",
    "has-[>[data-page]]:p-0",
  ]) {
    assert.ok(MAIN_CLASS_NAME.split(" ").includes(name), name);
  }
});

test("the avatar shows the profile photo when there is one, else the initials", () => {
  const photo = renderToStaticMarkup(
    createElement(Avatar, { name: "Ada Lovelace", imageUrl: "https://img.example/ada.png" }),
  );
  assert.match(photo, /<img[^>]+src="https:\/\/img.example\/ada.png"/);
  assert.match(photo, /alt=""/);
  const initials = renderToStaticMarkup(
    createElement(Avatar, { name: "Ada Lovelace", imageUrl: null }),
  );
  assert.doesNotMatch(initials, /<img/);
  assert.match(initials, />AL</);
});

test("a hard load draws the shell skeleton while the shell resolves", () => {
  const html = renderToStaticMarkup(createElement(ShellSkeleton));
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /w-60/, "the rail at its expanded width");
  const layout = readFileSync(join(APP, "layout.tsx"), "utf8");
  assert.match(layout, /<Suspense fallback={<ShellSkeleton \/>}>/);
});
