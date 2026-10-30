import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ActionContext,
  actionKey,
  buildActionContext,
} from "@/lib/readings/intent-engine/actions";
import type { CatalogTool } from "@/lib/readings/intent-engine/catalog";
import { extractFrames } from "@/lib/readings/intent-engine/frames";
import { stem, VerbLexicon } from "@/lib/readings/intent-engine/text";

function context(catalog: CatalogTool[]): ActionContext {
  const verbs = new VerbLexicon();
  for (const t of catalog) verbs.learnTool(t.name);
  return buildActionContext(catalog, verbs);
}

const tool = (name: string, description: string, fields: string[] = []): CatalogTool => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f, { type: "string" }])),
  },
});

const TASKS = context([
  tool("acme__create_task", "Create a new task in a project; returns the new task id.", [
    "projectId",
    "title",
  ]),
  tool("acme__add_task_comment", "Add a comment to an existing task.", ["taskId", "body"]),
  tool("acme__list_tasks", "List the tasks in a project.", ["projectId"]),
  tool("acme__update_task", "Update a task's status, title or assignee.", ["taskId", "status"]),
  tool("acme__search_tasks", "Full-text search across tasks by keyword.", ["query"]),
]);

/** Another domain, so nothing here holds for one catalog only. */
const SHOP = context([
  tool("orders__cancel_order", "Cancel an order before it ships.", ["orderId"]),
  tool("payments__refund_payment", "Refund a payment to the customer's card.", [
    "paymentId",
    "amount",
  ]),
  tool("invoices__send_invoice", "Email an invoice to the customer.", ["invoiceId"]),
  tool("invoices__get_invoice", "Fetch one invoice with its line items.", ["invoiceId"]),
]);

function keys(text: string, ctx: ActionContext): string[] {
  return extractFrames(text, ctx.verbs).map((f) => {
    const k = actionKey(f, ctx);
    return k ? `${k.action}·${k.object}` : "none";
  });
}

const key = (action: string, object: string) => `${stem(action)}·${stem(object)}`;

test("paraphrases of one action share a key", () => {
  for (const text of [
    "create task",
    "add a new task",
    "make a task for the bug",
    "give new task id for it",
  ]) {
    assert.deepEqual(keys(text, TASKS), [key("create", "task")], text);
  }
  for (const text of [
    "add comment to task",
    "comment on task",
    "post progress comment",
    "Add a progress comment to an existing task",
  ]) {
    assert.deepEqual(keys(text, TASKS), [key("create", "comment")], text);
  }
  for (const text of [
    "list tasks in project",
    "show all tasks of project",
    "get the tasks in project",
  ]) {
    assert.deepEqual(keys(text, TASKS), [key("list", "task")], text);
  }
  for (const text of [
    "update task status to done",
    "mark task as done",
    "change the assignee of a task",
  ]) {
    assert.deepEqual(keys(text, TASKS), [key("update", "task")], text);
  }
});

test("different actions on one thing keep different keys", () => {
  const seen = new Set(
    [
      "create task",
      "add comment to task",
      "list tasks",
      "update task",
      "search tasks by text",
      "show task RC-12",
    ].map((t) => keys(t, TASKS)[0]),
  );
  assert.equal(seen.size, 6);
});

test("each frame of a multi-action ask gets its own key", () => {
  assert.deepEqual(keys("create task comment on task list tasks in project", TASKS), [
    key("create", "task"),
    key("create", "comment"),
    key("list", "task"),
  ]);
});

test("an ask the catalog does not cover has no key", () => {
  assert.deepEqual(keys("weather in paris", TASKS), ["none"]);
});

test("the same rules key another domain", () => {
  assert.deepEqual(keys("cancel the order and refund the customer", SHOP), [
    key("cancel", "order"),
    key("refund", "customer"),
  ]);
  assert.deepEqual(keys("email the invoice to acme", SHOP), [key("send", "invoice")]);
  assert.deepEqual(keys("show invoice INV-204", SHOP), [key("read", "invoice")]);
});

test("a facet of a thing is not the thing", () => {
  const ctx = context([
    tool("acme__get_task_details", "Get one task with its details.", ["taskId"]),
    tool("acme__list_recently_updated_tasks", "List tasks updated recently.", []),
    tool("docs__read_document_content", "Read a document's content.", ["documentId"]),
  ]);
  assert.deepEqual(keys("get task details for RC-12", ctx), [key("read", "task")]);
  assert.deepEqual(keys("list recently updated tasks", ctx), [key("list", "task")]);
  assert.deepEqual(keys("read document content", ctx), [key("read", "document")]);
});

test("the model keys with the project's action classes and things, read leniently", async () => {
  const { keyVocabulary, parseLlmKey } = await import("@/lib/readings/intent-engine/actions");
  const vocabulary = keyVocabulary(TASKS);
  assert.ok(
    vocabulary.actions.includes("assign") &&
      vocabulary.actions.includes("create") &&
      vocabulary.actions.includes("search"),
  );
  assert.deepEqual(
    vocabulary.objects,
    ["comment", "task"],
    "the catalog's things as its tool names write them, sorted",
  );
  const k = (action: unknown, object: unknown) => parseLlmKey({ action, object }, TASKS);
  assert.deepEqual(
    k("assign", "checklist"),
    { action: stem("assign"), object: stem("checklist") },
    "an object outside the catalog is kept",
  );
  assert.deepEqual(
    k("Add", "Tasks"),
    { action: stem("create"), object: stem("task") },
    "a synonym maps to its class; words are stemmed",
  );
  assert.deepEqual(
    k("delegate", "onboarding checklist"),
    { action: stem("assign"), object: stem("checklist") },
    "the last word of a short phrase",
  );
  assert.equal(k("summarize", "task"), null, "an action outside the classes is rejected");
  assert.equal(k("assign", "the"), null);
  assert.equal(k("assign", "create"), null, "an action is not a thing");
  assert.equal(
    k("create", "link"),
    null,
    "an action class is not a thing unless the catalog says so",
  );
  const links = context([
    tool("acme__add_task_link", "Attach a link to a task.", ["taskId", "url"]),
    tool("acme__add_task_comment", "Add a comment to a task.", ["taskId", "body"]),
    tool("acme__comment_task", "Comment on a task.", ["taskId", "body"]),
  ]);
  assert.deepEqual(
    parseLlmKey({ action: "create", object: "link" }, links),
    { action: stem("create"), object: stem("link") },
    "a catalog thing that is also an action class",
  );
  assert.deepEqual(
    parseLlmKey({ action: "create", object: "comment" }, links),
    { action: stem("create"), object: stem("comment") },
    "a catalog thing that is also a tool verb",
  );
  assert.equal(k(undefined, "task"), null);
  assert.equal(k("assign", "a very long object phrase here"), null);
});

test("the model is shown the catalog's things in the singular, the most-named first, at most KEY_OBJECTS", async () => {
  const { KEY_OBJECTS, keyVocabulary } = await import("@/lib/readings/intent-engine/actions");
  const plural = context([
    tool("list_tasks", "List tasks."),
    tool("search_documents", "Search documents."),
    tool("get_entries", "Get entries."),
    tool("list_boxes", "List boxes."),
    tool("get_campus", "Get the campus."),
    tool("list_pages", "List pages."),
  ]);
  assert.deepEqual(
    keyVocabulary(plural).objects,
    ["box", "campus", "document", "entry", "page", "task"],
    "a word ending in -us stays whole",
  );

  const letters = "abcdefghijklmnopqrstuvwxyz";
  const many = [...letters]
    .flatMap((a) => [...letters].map((b) => tool(`get_x${a}${b}`, "One thing each.")))
    .slice(0, KEY_OBJECTS + 10);
  const wide = context([
    tool("create_task", "Create a task."),
    tool("update_task", "Update a task."),
    ...many,
  ]);
  const shown = keyVocabulary(wide).objects;
  assert.equal(shown.length, KEY_OBJECTS);
  assert.ok(shown.includes("task"), "the thing two tools name is kept over things one tool names");
});

/** A site-operations catalog, where "schedule" is a thing (`get_project_schedule`) and a verb. */
const SITE = context([
  tool("get_purchase_order", "Read a project's purchase order for a material.", [
    "project_id",
    "material",
  ]),
  tool("track_material_delivery", "Track a purchase order's delivery status with the carrier.", [
    "po_number",
  ]),
  tool("get_project_schedule", "Read an activity's forecast finish and float.", [
    "project_id",
    "activity",
  ]),
  tool("check_payment_status", "Read whether an invoice or pay application was paid.", ["invoice"]),
  tool("book_inspection", "Book a city or third-party inspection.", ["project_id", "kind", "date"]),
]);

test("a status is a facet of its thing: asks about two things' status keep two keys", () => {
  const delivery = keys(
    "Check the delivery status of the curtain wall panels for Riverside MOB.",
    SITE,
  );
  const payment = keys("Check the payment status of invoice INV-45067", SITE);
  assert.notDeepEqual(delivery, payment);
  assert.ok(
    !delivery[0]!.endsWith("·status") && !payment[0]!.endsWith("·status"),
    `${delivery} / ${payment}`,
  );
});

test("a verb the catalog also uses as a thing stays a verb when it takes an object", () => {
  assert.notDeepEqual(
    keys("Schedule a site inspection with the city for Friday", SITE),
    keys("Is the steel erection behind schedule?", SITE),
  );
  assert.deepEqual(
    keys("comment on task", TASKS),
    [key("create", "comment")],
    "with a preposition after it, it is still the thing",
  );
});
