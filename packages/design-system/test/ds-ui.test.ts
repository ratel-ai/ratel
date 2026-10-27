// biome-ignore-all lint/correctness/noChildrenProp: the runner only picks up `.ts`, so components are built
// with createElement, and required `children` props have to be passed in props to typecheck.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cn } from "../src/cn";
import { Badge, StatusDot } from "../src/components/badge";
import { Button } from "../src/components/button";
import { Checkbox } from "../src/components/checkbox";
import { type Column, DataTable } from "../src/components/data-table";
import { DotEmblem, DotMeter, DotSpark } from "../src/components/dot-matrix";
import { maskSecret } from "../src/components/mask";
import { PageHeader } from "../src/components/page-header";
import { eventFromInside, isTypingTarget, stepIndex, withPeek } from "../src/components/peek";
import { Section } from "../src/components/section";
import { StatRow } from "../src/components/stat-row";
import { Callout, EmptyState } from "../src/components/states";
import { isCurrentTab } from "../src/components/tab-model";
import { nextSortDirection, rovingIndex, rowKeyAction } from "../src/components/table-model";

test("the open panel round-trips through the query string and leaves other state alone", () => {
  assert.equal(withPeek("", "run_1"), "?peek=run_1");
  assert.equal(withPeek("?sort=cost&dir=desc", "run_2"), "?sort=cost&dir=desc&peek=run_2");
  assert.equal(withPeek("sort=cost&peek=run_2", "run_3"), "?sort=cost&peek=run_3");
  assert.equal(withPeek("?sort=cost&peek=run_3", null), "?sort=cost");
  assert.equal(withPeek("?peek=run_3", null), "");
  assert.equal(
    withPeek("?peek=a", "b", "row"),
    "?peek=a&row=b",
    "a custom param leaves the default one alone",
  );
});

test("j and k step through the list and stop at both ends", () => {
  assert.equal(stepIndex(0, 1, 3), 1);
  assert.equal(stepIndex(2, 1, 3), 2, "the last row stays put");
  assert.equal(stepIndex(0, -1, 3), 0, "the first row stays put");
  assert.equal(stepIndex(-1, 1, 3), 0, "nothing open: next starts at the top");
  assert.equal(stepIndex(-1, -1, 3), 2, "nothing open: previous starts at the bottom");
  assert.equal(stepIndex(0, 1, 0), -1, "an empty list has nowhere to go");
});

test("single-letter shortcuts stay quiet while someone types", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget), true);
  assert.equal(isTypingTarget({ tagName: "textarea" } as unknown as EventTarget), true);
  assert.equal(
    isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget),
    true,
  );
  assert.equal(isTypingTarget({ tagName: "TR" } as unknown as EventTarget), false);
  assert.equal(isTypingTarget(null), false);
  const withRole = (role: string) =>
    ({ tagName: "DIV", getAttribute: () => role }) as unknown as EventTarget;
  assert.equal(
    isTypingTarget(withRole("option")),
    true,
    "Select and Menu typeahead keep their letters",
  );
  assert.equal(isTypingTarget(withRole("menuitem")), true);
  assert.equal(isTypingTarget(withRole("region")), false);
});

test("events that bubble through a portal are not the row's or the panel's", () => {
  const inside = { contains: () => true } as unknown as EventTarget;
  const outside = { contains: () => false } as unknown as EventTarget;
  const target = {} as EventTarget;
  assert.equal(eventFromInside({ currentTarget: inside, target }), true);
  assert.equal(eventFromInside({ currentTarget: outside, target }), false);
});

test("the table's one tab stop survives a filter that shrinks the rows", () => {
  assert.equal(rovingIndex(3, 1), 0, "three rows down, then one row left: it is the tab stop");
  assert.equal(rovingIndex(2, 5), 2);
  assert.equal(rovingIndex(-4, 5), 0);
  assert.equal(rovingIndex(0, 0), -1, "an empty table has no row to focus");
});

test("rows move with j and k, open with Enter and toggle their pick with Space or x", () => {
  const row = { onRow: true, canOpen: true, canToggle: true };
  assert.equal(rowKeyAction("j", row), "next");
  assert.equal(rowKeyAction("ArrowUp", row), "previous");
  assert.equal(rowKeyAction("Enter", row), "open");
  assert.equal(rowKeyAction(" ", row), "toggle");
  assert.equal(rowKeyAction("x", row), "toggle");
  assert.equal(rowKeyAction("x", { ...row, canToggle: false }), null, "no selection, no toggle");
  assert.equal(rowKeyAction("Enter", { ...row, canOpen: false }), null);
  const inside = { ...row, onRow: false };
  assert.equal(rowKeyAction(" ", inside), null, "a control inside the row keeps its own Space");
  assert.equal(rowKeyAction("Enter", inside), null);
  assert.equal(rowKeyAction("k", inside), "previous", "moving works from anywhere in the row");
});

test("a tab is current by its path, and a query-only link stays on this page", () => {
  assert.equal(isCurrentTab("/p/traces?range=7d", "/p/traces", true), true);
  assert.equal(isCurrentTab("/p/traces/spans?range=7d", "/p/traces/spans/x"), true);
  assert.equal(isCurrentTab("/p/traces/spans?range=7d", "/p/traces", false), false);
  assert.equal(isCurrentTab("?tab=b", "/p/traces"), true, "no path: this page, not every page");
  assert.equal(isCurrentTab("#details", "/p/traces", true), true);
  assert.equal(isCurrentTab("/p", "/p/traces", true), false);
});

test("a checkbox leaves the tab order only when asked", () => {
  const box = renderToStaticMarkup(createElement(Checkbox, { "aria-label": "Pick" }));
  assert.match(
    box,
    /role="checkbox"[^>]*tabindex="0"|tabindex="0"[^>]*role="checkbox"/,
    "a checkbox is a tab stop by default",
  );
  const quiet = renderToStaticMarkup(
    createElement(Checkbox, { "aria-label": "Pick", tabIndex: -1 }),
  );
  assert.match(quiet, /tabindex="-1"/);
  assert.doesNotMatch(quiet, /tabindex="0"/);
});

test("a sort header asks for its default direction first, then flips", () => {
  assert.equal(nextSortDirection("cost", undefined, "desc"), "desc");
  assert.equal(nextSortDirection("cost", { id: "name", direction: "asc" }, "desc"), "desc");
  assert.equal(nextSortDirection("cost", { id: "cost", direction: "desc" }, "desc"), "asc");
  assert.equal(nextSortDirection("cost", { id: "cost", direction: "asc" }, "desc"), "desc");
});

test("a secret keeps its prefix and last four characters and hides the rest", () => {
  assert.equal(maskSecret("rtl_live_3f9a8c7d2e1b4a5f6c7d8e9f0a1b4f2a"), "rtl_••••••••••••4f2a");
  assert.equal(maskSecret("short"), "•••••");
  assert.doesNotMatch(maskSecret("sk-proj-abcdefghijklmnop"), /cdefghijkl/);
});

test("class merging keeps the 13px UI size next to a text color", () => {
  assert.equal(cn("text-ui font-medium", "text-fg-muted"), "text-ui font-medium text-fg-muted");
  assert.equal(cn("text-ui", "text-sm"), "text-sm", "a later size still wins");
  assert.equal(cn("shadow-overlay", "shadow-dialog"), "shadow-dialog");
});

test("a pending button keeps its label and its focus, says it is busy and cannot be pressed twice", () => {
  const html = renderToStaticMarkup(
    createElement(Button, { loading: true, children: "Save description" }),
  );
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-disabled="true"/, "disabled for pointer and keyboard");
  assert.doesNotMatch(
    html,
    / disabled=""/,
    "but still focusable, so a keyboard user keeps their place",
  );
  assert.match(html, /Save description/);
  const idle = renderToStaticMarkup(createElement(Button, { children: "Save description" }));
  // Attribute forms only: every button's classes mention data-disabled.
  assert.doesNotMatch(idle, / (aria-disabled|aria-busy|data-disabled)=/);
});

test("status always carries its word next to the dot", () => {
  const html = renderToStaticMarkup(createElement(StatusDot, { tone: "danger", label: "Failed" }));
  assert.match(html, /aria-hidden="true"/, "the dot itself is decoration");
  assert.match(html, /Failed/);
  assert.match(
    renderToStaticMarkup(createElement(Badge, { tone: "accent", children: "3 suggestions" })),
    /3 suggestions/,
  );
});

test("a page has exactly one h1, with parent pages as links before it", () => {
  const html = renderToStaticMarkup(
    createElement(PageHeader, {
      title: "Run 8f3a",
      crumbs: [{ label: "Traces", href: "/project/p/traces" }],
      description: "Started 3 min ago.",
    }),
  );
  assert.equal(html.match(/<h1/g)?.length, 1);
  assert.match(html, /<a[^>]*href="\/project\/p\/traces"[^>]*>Traces<\/a>/);
  assert.match(html, /<h1[^>]*>Run 8f3a<\/h1>/);
  assert.doesNotMatch(html, /uppercase/, "no eyebrow above the title");
});

test("a section is a labelled region with a sentence-case h2", () => {
  const html = renderToStaticMarkup(
    createElement(Section, { title: "Recent runs", children: "rows" }),
  );
  const id = html.match(/aria-labelledby="([^"]+)"/)?.[1];
  assert.ok(id);
  assert.match(html, new RegExp(`<h2 id="${id}"[^>]*>Recent runs</h2>`));
});

test("stats are a description list, and a linked stat stays valid markup", () => {
  const html = renderToStaticMarkup(
    createElement(StatRow, {
      stats: [
        {
          label: "Runs",
          value: "24.6K",
          delta: { value: "+12%", direction: "up", good: true, label: "vs previous 7 days" },
        },
        { label: "Cost", value: "$312.40", href: "/project/p?peek=cost" },
      ],
    }),
  );
  assert.match(html, /^<dl/);
  assert.equal(html.match(/<dt/g)?.length, 2);
  assert.match(html, /<dt[^>]*><a[^>]*href="\/project\/p\?peek=cost"[^>]*>Cost<\/a><\/dt>/);
  assert.match(html, /vs previous 7 days/, "the delta says what it compares against");
  assert.match(html, /tabular-nums/);
});

test("empty states and callouts say what to do next with the right roles", () => {
  const empty = renderToStaticMarkup(
    createElement(EmptyState, {
      title: "No traces yet",
      description: "Send your first trace with the SDK.",
    }),
  );
  assert.match(empty, /No traces yet/);
  assert.match(
    renderToStaticMarkup(createElement(Callout, { tone: "danger", title: "Couldn't load spans" })),
    /role="alert"/,
  );
  assert.match(
    renderToStaticMarkup(createElement(Callout, { title: "Demo project" })),
    /role="note"/,
  );
});

type Row = { id: string; name: string; cost: number };
const columns: readonly Column<Row>[] = [
  { id: "name", header: "Run", cell: (row) => row.name },
  {
    id: "cost",
    header: "Cost",
    align: "right",
    sortHref: (direction) => `?sort=cost&dir=${direction}`,
    cell: (row) => row.cost,
  },
];

test("a table names itself, marks its sort, and keeps one row in the tab order", () => {
  const html = renderToStaticMarkup(
    createElement(DataTable<Row>, {
      caption: "Recent runs",
      columns,
      rows: [
        { id: "a", name: "First", cost: 2 },
        { id: "b", name: "Second", cost: 1 },
      ],
      rowKey: (row) => row.id,
      sort: { id: "cost", direction: "desc" },
      selectedKey: "b",
      onRowOpen: () => undefined,
    }),
  );
  assert.doesNotMatch(html, /aria-keyshortcuts/, "no selection, no shortcut");
  assert.match(
    renderToStaticMarkup(
      createElement(DataTable<Row>, {
        caption: "Picks",
        columns,
        rows: [{ id: "a", name: "First", cost: 2 }],
        rowKey: (row) => row.id,
        onRowToggle: () => undefined,
      }),
    ),
    /<tr[^>]*aria-keyshortcuts="x"/,
  );
  assert.match(html, /<caption class="sr-only">Recent runs<\/caption>/);
  assert.match(html, /aria-sort="descending"/);
  assert.match(
    html,
    /href="\?sort=cost&amp;dir=asc"/,
    "the sorted header offers the other direction",
  );
  assert.equal(html.match(/tabindex="0"/g)?.length, 1, "roving focus: one row is tabbable");
  assert.match(
    html,
    /<tr[^>]*aria-current="true"[^>]*>(?:(?!<\/tr>).)*Second/,
    "the open row is marked",
  );
  assert.match(html, /text-right tabular-nums/);
});

test("an empty table shows its empty state in place of the rows", () => {
  const html = renderToStaticMarkup(
    createElement(DataTable<Row>, {
      caption: "Recent runs",
      columns,
      rows: [],
      rowKey: (row) => row.id,
      empty: createElement(EmptyState, { title: "No runs match" }),
    }),
  );
  assert.match(html, /<td colspan="2"[^>]*>.*No runs match/i);
});

test("the brand marks carry their meaning for assistive tech, not just their dots", () => {
  const meter = renderToStaticMarkup(
    createElement(DotMeter, { value: 0.82, label: "First try 82%" }),
  );
  assert.match(meter, /role="meter"/);
  assert.match(meter, /aria-valuenow="82"/);
  assert.equal(meter.match(/bg-current/g)?.length, 16, "16 of 20 pixels lit for 82%");
  assert.match(
    renderToStaticMarkup(createElement(DotMeter, { value: Number.NaN, label: "Unknown" })),
    /aria-valuenow="0"/,
    "a missing value reads as empty, not as a crash",
  );
  const spark = renderToStaticMarkup(
    createElement(DotSpark, { values: [1, 2, 4], label: "Runs per day" }),
  );
  assert.match(spark, /role="img"[^>]*aria-label="Runs per day"/);
  assert.match(spark, /bg-accent-mark/, "the latest bucket is the coral one");
  assert.match(renderToStaticMarkup(createElement(DotEmblem, {})), /aria-hidden="true"/);
});
