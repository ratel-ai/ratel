import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hitOverlap,
  retryReaching,
  sameAsk,
  searchedAgainForSame,
  turnDetour,
  turnFirstTry,
} from "@/lib/ledger/same-ask";
import type { StepDraft } from "@/lib/ledger/types";
import { fresh, signalTurns } from "@/lib/readings/trace-signals/signals/test-fixtures";

const search = (hitIds: string[], queryHash: string | null = null) =>
  ({ kind: "search", queryHash, hitIds }) as Pick<StepDraft, "kind" | "queryHash" | "hitIds">;

test("sameAsk: an identical query hash, or top-10 hit overlap at the bar", () => {
  assert.equal(sameAsk(search(["a"], "h1"), search(["z"], "h1")), true, "same hash, any hits");
  // {a,b,c} vs {a,b,d}: 2 shared of 4 = 0.5, exactly the default bar.
  assert.equal(hitOverlap(search(["a", "b", "c"]), search(["a", "b", "d"])), 0.5);
  assert.equal(
    sameAsk(search(["a", "b", "c"]), search(["a", "b", "d"])),
    true,
    "at the bar is the same ask",
  );
  // {a,b,c,d} vs {a,b,e,f}: 2 of 6 = 0.33, under the bar.
  assert.equal(sameAsk(search(["a", "b", "c", "d"]), search(["a", "b", "e", "f"])), false);
  assert.equal(
    sameAsk(search(["a", "b", "c"]), search(["a", "b", "d"]), 0.51),
    false,
    "the bar is tunable",
  );
  assert.equal(sameAsk(search([]), search(["a"])), false, "no hits and no hash: cannot tell");
  const deep = Array.from({ length: 20 }, (_, i) => `t${i}`);
  assert.equal(
    hitOverlap(search(deep), search([...deep.slice(0, 10), "x"])),
    1,
    "only the top 10 count",
  );
});

/** Kayra's case: two needs, each served by its own search. */
function twoNeeds() {
  return signalTurns([
    fresh()
      .search(["find_task", "search_tasks", "list_projects"], {
        query: "find the Q3 roadmap review",
      })
      .invoke("find_task")
      .search(["search_tasks", "list_task_comments", "create_task", "update_task"], {
        query: "change the priority of the Q3 roadmap review",
      })
      .invoke("update_task"),
  ])[0]!;
}

/** A retry: the first list misses the tool, the agent asks the same thing again. */
function retried() {
  return signalTurns([
    fresh()
      .search(["search_documents", "search_projects", "entity_lookup"], {
        query: "open the pricing doc",
      })
      .search(["get_document_content", "search_documents", "search_projects"], {
        query: "full text of the pricing doc",
      })
      .invoke("get_document_content"),
  ])[0]!;
}

test("a multi-step turn with fresh searches is first try and no detour", () => {
  const turn = twoNeeds();
  assert.equal(turnFirstTry(turn.steps), true);
  assert.equal(turnDetour(turn.steps), false);
  const update = turn.steps.find((s) => s.targetId === "update_task")!;
  assert.equal(retryReaching(turn.steps, update), null, "not a first-try miss");
});

test("a genuine retry is a detour, not first try, and names the search it repeated", () => {
  const turn = retried();
  assert.equal(turnFirstTry(turn.steps), false);
  assert.equal(turnDetour(turn.steps), true);
  const call = turn.steps.find((s) => s.targetId === "get_document_content")!;
  const retry = retryReaching(turn.steps, call);
  assert.equal(retry?.previous.searchOrdinal, 1);
  assert.equal(retry?.extraSearches, 1);
  assert.equal(retry?.listedEarlier, false);
});

test("searched again for the same thing, versus a next step after a call", () => {
  const same = signalTurns([
    fresh()
      .search(["entity_lookup", "list_members", "x"])
      .invoke("entity_lookup")
      .search(["list_members", "entity_lookup", "x"])
      .invoke("list_members"),
  ])[0]!;
  const lookup = same.steps.findIndex((s) => s.targetId === "entity_lookup");
  assert.equal(searchedAgainForSame(same.steps, lookup, 30_000), true);
  const next = twoNeeds();
  const find = next.steps.findIndex((s) => s.targetId === "find_task");
  assert.equal(searchedAgainForSame(next.steps, find, 30_000), false);
});
