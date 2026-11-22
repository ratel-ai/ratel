import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIX_GROUP_LINES,
  FIX_GROUP_TITLES,
  FIX_GROUPS,
  FIX_KIND_GROUP,
  fixGroup,
  groupAnchor,
  groupFixes,
} from "@/lib/views/fixes/groups";
import { FIX_KINDS } from "@/lib/views/fixes/kinds";

/** Words the product never shows (DESIGN.md, The product's nouns). */
const FORBIDDEN = /workflow|tool craft|suggestion|proposal|signal|craft|topic|jev|bm25|\u2014/i;

test("every kind of fix belongs to one table, by what you do with it", () => {
  for (const kind of FIX_KINDS) assert.ok(FIX_GROUPS.includes(FIX_KIND_GROUP[kind]), kind);
  assert.equal(fixGroup("rewrite"), "descriptions");
  assert.equal(
    fixGroup("tell-apart"),
    "descriptions",
    "telling two tools apart is a description change",
  );
  assert.equal(fixGroup("merge"), "tools");
  assert.equal(fixGroup("fail-clearly"), "tools");
  assert.equal(fixGroup("skill"), "skills");
  assert.equal(fixGroup("fewer-results"), "ranking");
});

test("tables in the order you work through them, the empty ones left out", () => {
  const fixes = [
    { id: "a", group: "tools" as const },
    { id: "b", group: "descriptions" as const },
    { id: "c", group: "tools" as const },
    { id: "d", group: "ranking" as const },
  ];
  assert.deepEqual(
    groupFixes(fixes).map(({ group, fixes: inGroup }) => [group, inGroup.map((fix) => fix.id)]),
    [
      ["descriptions", ["b"]],
      ["tools", ["a", "c"]],
      ["ranking", ["d"]],
    ],
  );
  assert.deepEqual(groupFixes([]), []);
  assert.equal(groupAnchor("tools"), "fixes-tools");
});

test("each table is titled by what you do there, in plain words and sentence case", () => {
  assert.deepEqual(Object.values(FIX_GROUP_TITLES), [
    "Update descriptions",
    "Change your tools",
    "Add skills",
    "Ranking settings",
  ]);
  for (const group of FIX_GROUPS) {
    for (const text of [FIX_GROUP_TITLES[group], FIX_GROUP_LINES[group]]) {
      assert.doesNotMatch(text, FORBIDDEN, text);
      assert.equal(text[0], text[0]!.toUpperCase(), text);
    }
    // One line, not a paragraph.
    assert.ok(FIX_GROUP_LINES[group].length <= 70, FIX_GROUP_LINES[group]);
  }
});
