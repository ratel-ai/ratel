import assert from "node:assert/strict";
import { test } from "node:test";
import { IntentPin, NOUN_ICONS, TaskPin, ToolPin } from "@ratel/design-system/entity";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("a tool, a task and an intent each read as an identity: a mark, then the name in text", () => {
  const tool = renderToStaticMarkup(
    createElement(ToolPin, {
      name: "track_delivery",
      href: "/project/p1/catalogs/tools?highlight=track_delivery",
    }),
  );
  assert.match(
    tool,
    /^<a(?=[^>]*href="\/project\/p1\/catalogs\/tools\?highlight=track_delivery")(?=[^>]*class="[^"]*font-mono)[^>]*><svg[^>]*lucide-wrench[^>]*aria-hidden="true"[^>]*>.*<\/svg><span[^>]*>track_delivery<\/span><\/a>$/,
  );
  const missing = renderToStaticMarkup(
    createElement(ToolPin, { name: "gone_tool", missing: true }),
  );
  assert.match(
    missing,
    /<span class="[^"]*border-dashed[^"]*">/,
    "a tool the catalog lost is dashed",
  );
  const task = renderToStaticMarkup(
    createElement(TaskPin, { name: "Track delivery", slot: "chart-1" }),
  );
  assert.match(task, /bg-chart-1[^>]*><\/span><span[^>]*>Track delivery<\/span>/);
  const intent = renderToStaticMarkup(
    createElement(IntentPin, { name: "Where is my order", href: "/project/p1/intents?peek=t_1" }),
  );
  assert.match(intent, />Where is my order<\/span><\/a>$/);
  // An intent's name comes from people's asks: text only, never an attribute.
  assert.doesNotMatch(intent, /="[^"]*Where is my order/);
});

test("one icon per noun, the same everywhere", () => {
  assert.deepEqual(Object.keys(NOUN_ICONS), [
    "intent",
    "conversation",
    "flow",
    "task",
    "tool",
    "skill",
    "issue",
    "selfCorrection",
    "fix",
  ]);
});
