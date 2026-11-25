// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { HALLUCINATIONS_DESCRIPTION } from "@/components/console/hallucinations/copy";
import { HallucinationsSkeleton } from "@/components/console/hallucinations/HallucinationsSkeleton";
import { render } from "@/lib/views/tasks/test-support";

test("the page's skeleton has its shape: three numbers, the ring beside its groups, then the table", () => {
  const html = render(createElement(HallucinationsSkeleton), {
    pathname: "/project/p1/health/hallucinations",
  });
  assert.match(html, />Hallucinations</);
  assert.ok(html.includes(HALLUCINATIONS_DESCRIPTION.replaceAll("'", "&#x27;")));
  assert.equal((html.match(/data-skeleton-stat=""/g) ?? []).length, 3);
  assert.match(html, /data-skeleton-ring=""/);
  assert.equal((html.match(/data-skeleton-group=""/g) ?? []).length, 3);
  assert.match(html, /data-skeleton-table=""/);
});
