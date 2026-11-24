// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { RootCauseLink, RootCausesHost } from "@/components/console/sentiment/RootCausesHost";
import { SeeMoreList } from "@/components/console/turn-panel/SeeMoreList";
import { render } from "@/lib/views/tasks/test-support";

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row-${i + 1}`);

function list(items: string[]): string {
  return render(
    // The list takes a render function as its child.
    createElement(
      SeeMoreList<string> as never,
      { items, itemKey: (item: string) => item, "data-list": "rows" } as never,
      ((item: string) => createElement("span", { "data-row": item }, item)) as never,
    ),
  );
}

test("a long list shows its first ten, and See more says how many are left", () => {
  const html = list(rows(23));
  const shown = [...html.matchAll(/data-row="(row-\d+)"/g)].map((match) => match[1]);
  assert.deepEqual(shown, rows(10));
  assert.match(html, /data-list="rows"/);
  assert.match(html, /data-see-more=""[^]*See more[^]*>13</);
});

test("a list of ten or fewer has no See more", () => {
  assert.doesNotMatch(list(rows(10)), /data-see-more/);
  assert.doesNotMatch(list([]), /data-see-more/);
});

test("a root cause link is a link, and a host page shows its own content under the panel", () => {
  const link = render(
    createElement(RootCauseLink, { href: "/project/p1/health?rc=1" }, "See root causes"),
  );
  assert.match(link, /<a[^>]*href="\/project\/p1\/health\?rc=1"[^>]*>See root causes<\/a>/);

  const host = (search: string) =>
    render(
      createElement(
        RootCausesHost as never,
        {
          content: createElement("p", { "data-analysis": "" }, "the analysis"),
          groups: [],
          subtitle: "Last 30 days",
          now: "2026-09-02T00:00:00.000Z",
          turn: null,
          otherParam: "peek",
        } as never,
        createElement("main", { "data-host-page": "" }, "Agent health"),
      ),
      { pathname: "/project/p1/health", search },
    );
  // Closed: the host page alone.
  const closed = host("days=30");
  assert.match(closed, /data-host-page=""/);
  assert.doesNotMatch(closed, /data-analysis/);
  // Open, the panel is a portal of the design system's Panel: a server render does not draw it.
});
