import assert from "node:assert/strict";
import { test } from "node:test";
import { MenuContent, MenuItem, MenuSeparator } from "@ratel/design-system/menu";
import { Children, createElement, type ReactElement, type ReactNode } from "react";
import { AccountMenu } from "@/components/console/shell/AccountMenu";

const account = { name: "Ada Lovelace", email: "ada@example.com" };
const Start = () => null;
const End = () => null;

type Props = { children?: ReactNode };

/** The menu's items in order, each named by its label, its component or "separator". */
function menuItems(props: Partial<Parameters<typeof AccountMenu>[0]>): string[] {
  const menu = AccountMenu({ account, collapsed: false, onShortcuts: () => {}, ...props });
  const content = Children.toArray((menu as ReactElement<Props>).props.children).find(
    (child) => (child as ReactElement).type === MenuContent,
  ) as ReactElement<Props>;
  return Children.toArray(content.props.children).flatMap((child) => {
    const element = child as ReactElement<Props>;
    if (element.type === "div") return [];
    if (element.type === MenuSeparator) return ["separator"];
    if (element.type === MenuItem) return [String(element.props.children)];
    if (element.type === Start) return ["start"];
    if (element.type === End) return ["end"];
    return [String(element.type)];
  });
}

test("OSS: the menu is the docs and the shortcuts", () => {
  assert.deepEqual(menuItems({}), ["separator", "Documentation", "Keyboard shortcuts"]);
});

test("the edition's items come before the docs, and nothing follows the shortcuts without end items", () => {
  assert.deepEqual(menuItems({ editionItems: createElement(Start) }), [
    "separator",
    "start",
    "Documentation",
    "Keyboard shortcuts",
  ]);
});

test("the edition's end items follow the shortcuts", () => {
  assert.deepEqual(
    menuItems({ editionItems: createElement(Start), editionEndItems: createElement(End) }),
    ["separator", "start", "Documentation", "Keyboard shortcuts", "end"],
  );
});

/** The lines at the top of the menu, above the first separator. */
function headerLines(props: Partial<Parameters<typeof AccountMenu>[0]>): string[] {
  const menu = AccountMenu({ account, collapsed: false, onShortcuts: () => {}, ...props });
  const content = Children.toArray((menu as ReactElement<Props>).props.children).find(
    (child) => (child as ReactElement).type === MenuContent,
  ) as ReactElement<Props>;
  const header = Children.toArray(content.props.children).find(
    (child) => (child as ReactElement).type === "div",
  ) as ReactElement<Props>;
  return Children.toArray(header.props.children).map((line) =>
    String((line as ReactElement<Props>).props.children),
  );
}

test("the edition's note sits under the name and email (upstream's local-session line)", () => {
  assert.deepEqual(headerLines({}), ["Ada Lovelace", "ada@example.com"]);
  assert.deepEqual(
    headerLines({ account: { ...account, note: "Local session (auth bypassed)" } }),
    ["Ada Lovelace", "ada@example.com", "Local session (auth bypassed)"],
  );
});
