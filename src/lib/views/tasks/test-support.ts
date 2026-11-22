import Module from "node:module";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Render helpers for the task page tests: the router contexts the client
 * parts read, and the checks every task page passes (DESIGN.md's copy and
 * type rules, the product's nouns, and no request text in an attribute).
 */

// Stylesheet imports of the ds runtime load as nothing under node.
(
  Module as unknown as { _extensions: Record<string, (module: { exports: unknown }) => void> }
)._extensions[".css"] = (module) => {
  module.exports = {};
};

const ROUTER = {
  back() {},
  forward() {},
  prefetch() {},
  push() {},
  replace() {},
  refresh() {},
  hmrRefresh() {},
} as unknown as AppRouterInstance;

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

export function render(
  node: ReactElement,
  { pathname = `/project/${PROJECT_ID}/health/tasks`, search = "" } = {},
): string {
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: ROUTER },
      createElement(
        PathnameContext.Provider,
        { value: pathname },
        createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) }, node),
      ),
    ),
  );
}

/** The words a reader sees: markup stripped. */
export function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** Every attribute value in the markup. */
export function attributeValues(html: string): string[] {
  return [...html.matchAll(/\s[\w:-]+="([^"]*)"/g)].map((match) => match[1]!);
}
