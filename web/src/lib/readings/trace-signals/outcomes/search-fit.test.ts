import assert from "node:assert/strict";
import { test } from "node:test";
import {
  queryClass,
  type SearchContext,
  unmetSearches,
} from "@/lib/readings/trace-signals/outcomes/search-fit";
import { fresh, signalTurns } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

const one = (fixture: Parameters<typeof signalTurns>[0][number]): SignalTurn =>
  signalTurns([fixture])[0]!;

/** The turn's unmet runs, with the words of every search captured and the session's later calls. */
function unmet(
  fixture: Parameters<typeof signalTurns>[0][number],
  words: readonly (string | null)[],
  over: { later?: Record<string, number>; lastCalls?: null } = {},
) {
  const turn = one(fixture);
  const searches = turn.steps.filter((step) => step.kind === "search");
  const end = searches.at(-1)!.occurredAt.getTime();
  const context: SearchContext = {
    queries: new Map(
      searches.flatMap((step, i) => {
        const query = words[i];
        return query ? [[step.traceEventId, query] as const] : [];
      }),
    ),
    lastCalls:
      over.lastCalls === null
        ? null
        : new Map(Object.entries(over.later ?? {}).map(([tool, ms]) => [tool, new Date(end + ms)])),
  };
  return unmetSearches(turn.steps, context).map((run) => [run.query, run.wanted, run.offered]);
}

test("a search that returned nothing met no fitting tool, with or without its words", () => {
  assert.deepEqual(unmet(fresh().search([]), ["archive board"]), [["archive board", null, []]]);
  assert.deepEqual(unmet(fresh().search([]), [null]), [[null, null, []]]);
});

test("a search whose hits were not sent did not return nothing: it cannot be told", () => {
  // OpenTelemetry searches with no hit count arrive as an empty list and no count.
  const turn = one(fresh().search(["create_task"]));
  const unsent = turn.steps.map((step) =>
    step.kind === "search" ? { ...step, hitIds: [], hitCount: null } : step,
  );
  const context: SearchContext = {
    queries: new Map([[turn.steps[0]!.traceEventId, "create task"]]),
    lastCalls: new Map(),
  };
  assert.deepEqual(unmetSearches(unsent, context), []);
  // A count of zero is a search that returned nothing.
  const none = turn.steps.map((step) =>
    step.kind === "search" ? { ...step, hitIds: [], hitCount: 0 } : step,
  );
  assert.equal(unmetSearches(none, context).length, 1);
});

test("no listed tool does the kind of action asked, and none was run later", () => {
  assert.deepEqual(unmet(fresh().search(["crop_photo", "upload_photo"]), ["delete photo"]), [
    ["delete photo", "remove", ["crop_photo", "upload_photo"]],
  ]);
});

test("a listed tool that does that kind of action fits, run or not", () => {
  assert.deepEqual(unmet(fresh().search(["create_task", "list_tasks"]), ["create task"]), []);
});

test("a listed tool run later in the session fits, whatever its name says", () => {
  const search = () => fresh().search(["upload_photo"]);
  assert.deepEqual(unmet(search(), ["delete image"], { later: { upload_photo: 60_000 } }), []);
  // A call before the search says nothing about it, nor does a later call of a tool it did not list.
  assert.equal(unmet(search(), ["delete image"], { later: { upload_photo: -60_000 } }).length, 1);
  assert.equal(unmet(search(), ["delete image"], { later: { get_image: 60_000 } }).length, 1);
});

test("what cannot be told is not unmet", () => {
  const search = () => fresh().search(["upload_photo"]);
  // No words, no known verb in them, sessions that cannot be told apart.
  assert.deepEqual(unmet(search(), [null]), []);
  assert.deepEqual(unmet(search(), ["image assets"]), []);
  assert.deepEqual(unmet(search(), ["delete image"], { lastCalls: null }), []);
  // No listed tool names what it does.
  assert.deepEqual(unmet(fresh().search(["images", "weather"]), ["delete image"]), []);
  // A count with no list, and a list that was cut.
  assert.deepEqual(unmet(fresh().gatewaySearch(3), ["delete image"]), []);
  const turn = one(search());
  const cut = turn.steps.map((step) => ({ ...step, hitCount: 40 }));
  assert.deepEqual(
    unmetSearches(cut, {
      queries: new Map([[turn.steps[0]!.traceEventId, "delete image"]]),
      lastCalls: new Map(),
    }),
    [],
  );
});

test("a run of searches is read together: one that fits answers them all", () => {
  assert.deepEqual(
    unmet(fresh().search(["get_image"]).search(["remove_image"]), ["delete image", "remove image"]),
    [],
  );
  assert.deepEqual(
    unmet(fresh().search([]).search(["get_image"]), ["delete image", "remove image"]),
    [["remove image", "remove", ["get_image"]]],
  );
});

test("a run with a call after it, and a catalog listing, are never unmet", () => {
  assert.deepEqual(unmet(fresh().search(["get_image"]).invoke("get_image"), ["delete image"]), []);
  const listing = Array.from({ length: 6 }).reduce<ReturnType<typeof fresh>>(
    (turn) => turn.search([]),
    fresh(),
  );
  assert.deepEqual(unmet(listing, []), []);
});

test("a search's verb is the action it opens with, past filler; a noun that looks like a verb is none", () => {
  const cases: Array<[string, string | null]> = [
    ["delete image", "remove"],
    ["create task", "create"],
    ["find a tool to send email", "create"],
    ["how do I look up a customer", null],
    ["how do I delete a customer", "remove"],
    ["tool to archive the board", "remove"],
    ["please update the ticket status", "change"],
    // Nouns that look like verbs, and words that open no action.
    ["blog post comments", null],
    ["list of new users to delete", null],
    ["set up a meeting", null],
    ["order status", null],
    ["image assets", null],
    ["", null],
  ];
  for (const [query, expected] of cases) assert.equal(queryClass(query), expected, query);
});

test("a search worded as a sentence is not unmet on a wrongly read verb", () => {
  // "post" is a noun here: no verb is read, so nothing is said.
  assert.deepEqual(unmet(fresh().search(["get_comments"]), ["blog post comments"]), []);
  // The action after the filler is the one compared.
  assert.deepEqual(unmet(fresh().search(["send_email"]), ["find a tool to send email"]), []);
});
