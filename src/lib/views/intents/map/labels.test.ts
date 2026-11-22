import assert from "node:assert/strict";
import { test } from "node:test";
import {
  absoluteTime,
  askGroupLabel,
  graphChoiceLabel,
  graphChoices,
  pickGraph,
  tidyAsk,
  timeAgo,
  truncateWords,
} from "@/lib/views/intents/map/labels";

test("times read as people say them, with a non-breaking space before the unit", () => {
  const now = new Date(Date.UTC(2026, 9, 15, 14, 2, 0));
  const ago = (ms: number) => timeAgo(new Date(now.getTime() - ms), now);
  assert.equal(ago(20_000), "Just now");
  assert.equal(ago(12 * 60_000), "12 min ago");
  assert.equal(ago(5 * 3_600_000), "5 h ago");
  assert.equal(ago(3 * 86_400_000), "3 days ago");
  assert.equal(ago(90 * 86_400_000), "17 Jul 2026");
  assert.equal(
    timeAgo(new Date(now.getTime() + 5_000), now),
    "Just now",
    "a clock a little ahead is not the future",
  );
  assert.equal(absoluteTime(now), "15 Oct 2026, 14:02 UTC");
});

test("an ask group reads as the ask itself, tidied, never as its id", () => {
  assert.equal(askGroupLabel({ label: "create a task" }), "Create a task");
  assert.equal(askGroupLabel({ label: "  where is   order 1042?? " }), "Where is order 1042");
  assert.equal(
    askGroupLabel({ label: "update a task's status", labelOverride: "Change a task's status" }),
    "Change a task's status",
  );
  assert.equal(
    askGroupLabel({ label: "", terms: ["order", "status", "refund", "extra"] }),
    "Order, status, refund",
  );
  assert.equal(
    askGroupLabel({ label: "???", terms: [] }),
    "Unnamed ask",
    "punctuation alone is no label",
  );
  assert.equal(askGroupLabel({ label: "", labelOverride: "   ", terms: [] }), "Unnamed ask");
});

test("a long ask is cut at a word, with an ellipsis", () => {
  const long =
    "find every place that reads the rate limit environment variable and summarize how it is applied";
  const label = askGroupLabel({ label: long }, 40);
  assert.ok(label.length <= 40, label);
  assert.ok(label.endsWith("…"));
  assert.doesNotMatch(label, / …$/, "no space before the ellipsis");
  assert.equal(truncateWords("short", 10), "short");
  assert.equal(
    truncateWords("averyveryverylongsingleword", 10),
    "averyvery…",
    "one long word is cut where it must be",
  );
  assert.equal(tidyAsk("ok."), "Ok");
});

test("graphs are offered as who built them, merged first", () => {
  assert.deepEqual(graphChoiceLabel("cloud", "cloud"), {
    graphKey: "cloud",
    label: "All runtimes",
    origin: "cloud",
  });
  assert.deepEqual(graphChoiceLabel("cloud/dev-assistant", "cloud"), {
    graphKey: "cloud/dev-assistant",
    label: "dev-assistant only",
    origin: "cloud-source",
  });
  assert.equal(graphChoiceLabel("checkout-bot", "runtime").label, "checkout-bot (uploaded)");
  const choices = graphChoices([
    { graphKey: "zeta", producer: "runtime" },
    { graphKey: "cloud/b", producer: "cloud" },
    { graphKey: "cloud", producer: "cloud" },
    { graphKey: "cloud/a", producer: "cloud" },
  ]);
  assert.deepEqual(
    choices.map((choice) => choice.graphKey),
    ["cloud", "cloud/a", "cloud/b", "zeta"],
  );
});

test("the page shows the graph asked for, else the merged one, else the first", () => {
  const choices = graphChoices([
    { graphKey: "cloud/a", producer: "cloud" },
    { graphKey: "cloud", producer: "cloud" },
  ]);
  assert.equal(pickGraph(choices, "cloud/a")?.graphKey, "cloud/a");
  assert.equal(
    pickGraph(choices, "gone")?.graphKey,
    "cloud",
    "an unknown key falls back, never 404s",
  );
  assert.equal(pickGraph(choices, null)?.graphKey, "cloud");
  assert.equal(
    pickGraph(graphChoices([{ graphKey: "bot", producer: "runtime" }]), null)?.graphKey,
    "bot",
  );
  assert.equal(pickGraph([], "cloud"), null);
});
