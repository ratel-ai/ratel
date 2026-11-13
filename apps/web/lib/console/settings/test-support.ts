import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Render a v2 view the way the app does, for the render tests: with a router
 * mounted (useRouter), the current path (TabNav) and a query string (usePeek).
 * Test-only; the runner picks up `*.test.ts` files, not this one.
 */
export function renderWithRouter(
  element: ReactElement,
  { pathname = "/", search = "" } = {},
): string {
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router as never },
      createElement(
        PathnameContext.Provider,
        { value: pathname },
        createElement(
          SearchParamsContext.Provider,
          { value: new URLSearchParams(search) as never },
          element,
        ),
      ),
    ),
  );
}
