import assert from "node:assert/strict";
import { test } from "node:test";
import { type OutcomeSearch, scoreAskOutcomes } from "@/lib/views/intents/map/outcomes";

const search = (
  query: string,
  invokedToolId: string,
  firstToolId: string | null,
  shaped = false,
): OutcomeSearch => ({
  query,
  invokedToolId,
  firstToolId,
  shaped,
});
const groupOf = (query: string) =>
  query.includes("customer") ? "customers" : query.includes("order") ? "orders" : null;

test("each search is scored on the tool its own agent ran, so an even split between two tools is not a problem", () => {
  // Half the customer lookups run one tool, half the other, and each search put its own tool first.
  const searches = [
    ...Array.from({ length: 6 }, () =>
      search("look up a customer", "stripe_search_customers", "stripe_search_customers"),
    ),
    ...Array.from({ length: 6 }, () =>
      search("look up the customer by email", "stripe_get_customer", "stripe_get_customer"),
    ),
  ];
  const { outcomes } = scoreAskOutcomes(searches, groupOf);
  assert.deepEqual(outcomes, [{ clusterId: "customers", ranked: 12, firstTry: 12, shaped: 0 }]);
});

test("a list a Ratel graph ranked is counted apart, a search that served nothing is skipped, and only kept groups return", () => {
  const searches = [
    search("find an order", "lookup_order", "lookup_order"),
    search("find order 7", "lookup_order", "stripe_list_invoices"),
    search("where is my order", "lookup_order", "lookup_order", true),
    search("find an order", "lookup_order", null),
    search("look up a customer", "stripe_get_customer", "stripe_get_customer"),
    search("the weather", "weather", "weather"),
  ];
  const { outcomes, classified } = scoreAskOutcomes(searches, groupOf, {
    keep: new Set(["orders"]),
  });
  assert.deepEqual(outcomes, [{ clusterId: "orders", ranked: 2, firstTry: 1, shaped: 1 }]);
  assert.equal(classified, 6);
});

test("attribution stops at its time budget and says how far it got", () => {
  let now = 0;
  const clock = () => now;
  const searches = Array.from({ length: 200 }, () =>
    search("find an order", "lookup_order", "lookup_order"),
  );
  const { classified } = scoreAskOutcomes(
    searches,
    (query) => {
      now += 1;
      return groupOf(query);
    },
    { deadline: 100, clock },
  );
  assert.ok(classified < 200 && classified >= 100, `stopped near the budget, at ${classified}`);
});
