import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAUSE_PATTERNS,
  causeOfError,
  createCauseTally,
  normalizeErrorMessage,
  readError,
} from "@/lib/readings/trace-signals/outcomes/error-cause";
import { OUTCOME_CAUSES, type OutcomeCause } from "@/lib/readings/trace-signals/outcomes/kinds";

/**
 * Invented messages in the shapes real tools send: bare codes, one short
 * sentence, a sentence with advice after it, a sentence that lists what was
 * allowed. No customer string is copied here.
 */
const SHAPES: readonly [message: string, cause: OutcomeCause, pattern: string | null][] = [
  // Bare codes.
  ["validation_failed", "bad_arguments", "invalid"],
  ["operation_failed", "tool_fault", "failed"],
  ["InvalidArgument", "bad_arguments", "invalid"],
  ["RESOURCE_NOT_FOUND", "wrong_reference", "not_found"],
  ["permission-denied", "not_allowed", "refused"],
  ["http_403", "not_allowed", "refused"],
  ["rate_limit_exceeded", "tool_fault", "transient"],
  ["DEADLINE_EXCEEDED", "tool_fault", "transient"],
  // A record that did not resolve.
  ["Invoice not found", "wrong_reference", "not_found"],
  [
    "Calendar event not found. Check the link and make sure you have access.",
    "wrong_reference",
    "not_found",
  ],
  ["Folder not found or not accessible", "wrong_reference", "not_found"],
  ["The requested page was not found or is not accessible.", "wrong_reference", "not_found"],
  ["BillingProfile not found", "wrong_reference", "not_found"],
  ['No reviewer matched "sam@example.org" in this team.', "wrong_reference", "no_match"],
  ["Parent invoice creation returned no invoice", "wrong_reference", "no_match"],
  ["No such channel: C0ABC1234", "wrong_reference", "not_found"],
  // What the caller sent.
  ["Invalid request", "bad_arguments", "invalid"],
  ["Summary must be 2000 characters or less", "bad_arguments", "required"],
  ["Title is too long", "bad_arguments", "limit"],
  ["Missing required field: due_date", "bad_arguments", "required"],
  [
    "Invalid stageKey or stageId — stage not available in the target pipeline. Available: New (7QX2ABCD; set:7QX2YYzz), Won (7QX2EFGH; set:7QX2YYzz). Do not delete as a substitute for a stage change.",
    "bad_arguments",
    "invalid",
  ],
  ["A line item's currency is inherited from its parent invoice.", "bad_arguments", "not_settable"],
  ["A label with this name already exists", "bad_arguments", "not_settable"],
  // What the tool did.
  ["Internal server error", "tool_fault", "server"],
  ["upstream request timed out after 30000ms", "tool_fault", "transient"],
  ["Service temporarily unavailable", "tool_fault", "transient"],
  ["Request failed. Unexpected end of stream.", "tool_fault", "failed"],
  // A refusal.
  ["Only Acme-authored pages can be edited via the API", "not_allowed", "only_some_may"],
  ["You do not have permission to archive this board", "not_allowed", "refused"],
  ["Authentication failed", "not_allowed", "sign_in"],
  ["insufficient_credits", "not_allowed", "plan_or_budget"],
  // Nothing the table knows.
  ["Something odd happened", "other", null],
  ["E_UNKNOWN", "other", null],
];

test("each shape sorts into its cause, by the pattern meant for it", () => {
  for (const [message, cause, pattern] of SHAPES) {
    const reading = readError(message);
    assert.deepEqual(
      { cause: reading?.cause, pattern: reading?.pattern },
      { cause, pattern },
      message,
    );
  }
});

test("every cause but other has a pattern, and every pattern is exercised", () => {
  const causes = new Set(CAUSE_PATTERNS.map((pattern) => pattern.cause));
  assert.deepEqual([...causes].sort(), OUTCOME_CAUSES.filter((cause) => cause !== "other").sort());
  const used = new Set(SHAPES.map(([, , pattern]) => pattern));
  assert.deepEqual(
    CAUSE_PATTERNS.map((pattern) => pattern.id).filter((id) => !used.has(id)),
    [],
  );
});

test("a refusal that names a record is a refusal; a missing record that mentions access is not", () => {
  assert.equal(causeOfError("Access denied: project not found"), "not_allowed");
  assert.equal(causeOfError("Workspace not found or not accessible"), "wrong_reference");
});

test("the first sentence decides, and the rest is read only when it says nothing", () => {
  assert.equal(causeOfError("Board not found. Permission may be missing."), "wrong_reference");
  assert.equal(causeOfError("Oops. The record does not exist."), "wrong_reference");
});

test("ids, emails, urls, quoted values and numbers are stripped before grouping", () => {
  const key = normalizeErrorMessage;
  assert.equal(
    key('No reviewer matched "sam@example.org" in this team.'),
    key("No reviewer matched 'kim@example.com' in this team."),
  );
  assert.equal(
    key('No reviewer matched "sam@example.org" in this team.'),
    "no reviewer matched <value> in this team",
  );
  assert.equal(key("User sam@example.org not found"), "user <email> not found");
  assert.equal(
    key("Task 3f2b8c1e-7a4d-4e2b-9c1f-0a1b2c3d4e5f not found"),
    key("Task 01HZX3K9QW8R7T6Y5V4U3S2P1N not found"),
  );
  assert.equal(key("Task 01HZX3K9QW8R7T6Y5V4U3S2P1N not found"), "task <id> not found");
  assert.equal(
    key("Could not fetch https://api.example.com/v1/items/42?x=1 (status 502)"),
    "could not fetch <url> (status <n>)",
  );
  assert.equal(
    key("Summary must be 2000 characters or less"),
    key("Summary must be 500 characters or less"),
  );
  assert.equal(key("  Invoice   not found.  "), "invoice not found");
});

test("an apostrophe is not a quote", () => {
  assert.equal(
    normalizeErrorMessage("A line item's currency is inherited from its parent's invoice."),
    "a line item's currency is inherited from its parent's invoice",
  );
});

test("a listing after the first sentence does not split one shape into many", () => {
  const a = "Invalid stageKey — stage not available. Available: New (7QX2ABCD), Won (7QX2EFGH).";
  const b = "Invalid stageKey — stage not available. Available: Open (9ZZ1QRST).";
  assert.equal(normalizeErrorMessage(a), normalizeErrorMessage(b));
  assert.equal(normalizeErrorMessage(a), "invalid stagekey — stage not available");
});

test("a structured error is read from its message fields", () => {
  assert.deepEqual(readError('{"code":"conflict","message":"Record 8812345 not found"}'), {
    key: "record <n> not found",
    cause: "wrong_reference",
    pattern: "not_found",
  });
  assert.equal(causeOfError('{"ok":false}'), "other");
});

test("an empty message is not read at all", () => {
  assert.equal(readError(""), null);
  assert.equal(readError("   "), null);
  assert.equal(causeOfError(null), null);
  assert.equal(normalizeErrorMessage(undefined), "");
});

test("unknown messages land in other and are counted, by distinct shape", () => {
  const tally = createCauseTally();
  for (const message of [
    "Something odd happened",
    "Something odd happened",
    'Widget "a1" wobbled',
    'Widget "b2" wobbled',
    "Invoice not found",
  ]) {
    tally.add(readError(message)!);
  }
  assert.deepEqual(tally.finish(), {
    byCause: { bad_arguments: 0, wrong_reference: 1, tool_fault: 0, not_allowed: 0, other: 4 },
    otherShapes: 2,
  });
});
