import assert from "node:assert/strict";
import { test } from "node:test";
import { extractModelJsonObject, ModelJsonError } from "./model-json";

test("parses a plain JSON object", () => {
  assert.deepEqual(extractModelJsonObject('{"a":1,"b":"two"}'), { a: 1, b: "two" });
});

test("tolerates code fences and surrounding prose", () => {
  const raw = 'Here you go:\n```json\n{"name":"x"}\n```\nHope that helps!';
  assert.deepEqual(extractModelJsonObject(raw), { name: "x" });
});

// THE PRODUCTION BUG (job e8173b64, 2026-07-28): a skill `body` is a multi-line
// markdown document. When the model emits a RAW newline inside the JSON string
// instead of the escaped \n, JSON.parse dies with "Bad control character in
// string literal" and the whole draft is lost. Long markdown bodies make this
// likely rather than rare, so the extractor repairs it instead of failing.
test("repairs a raw newline inside a string literal", () => {
  const raw = '{"body":"## When to use\nDo the thing.\n\n## Steps\n1. Go"}';
  const out = extractModelJsonObject(raw) as { body: string };
  assert.equal(out.body, "## When to use\nDo the thing.\n\n## Steps\n1. Go");
});

test("repairs raw tabs and carriage returns inside a string literal", () => {
  const out = extractModelJsonObject('{"body":"a\tb\r\nc"}') as { body: string };
  assert.equal(out.body, "a\tb\r\nc");
});

test("repairs other control characters inside a string literal", () => {
  const out = extractModelJsonObject('{"body":"a�b�c"}') as { body: string };
  assert.equal(out.body, "a�b�c");
});

// The repair must be surgical: control characters BETWEEN tokens are ordinary
// JSON whitespace and pretty-printed output is full of them. Escaping those too
// would corrupt the document.
test("leaves structural whitespace between tokens alone", () => {
  const pretty = '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}';
  assert.deepEqual(extractModelJsonObject(pretty), { a: 1, b: [2, 3] });
});

test("does not corrupt an already-escaped \\n", () => {
  const out = extractModelJsonObject('{"body":"line1\\nline2"}') as { body: string };
  assert.equal(out.body, "line1\nline2");
});

// An escaped backslash ends the escape; a newline right after it is raw and must
// still be repaired. Naive "skip the char after every backslash" logic gets this
// wrong and produces invalid JSON.
test("tracks escaped backslashes when deciding what is escaped", () => {
  const out = extractModelJsonObject('{"body":"ends with backslash\\\\\nnext line"}') as {
    body: string;
  };
  assert.equal(out.body, "ends with backslash\\\nnext line");
});

test("a quote inside a string does not end the string when escaped", () => {
  const out = extractModelJsonObject('{"body":"say \\"hi\\"\nthen go"}') as { body: string };
  assert.equal(out.body, 'say "hi"\nthen go');
});

test("throws ModelJsonError when there is no JSON object at all", () => {
  assert.throws(() => extractModelJsonObject("I cannot help with that."), ModelJsonError);
  assert.throws(() => extractModelJsonObject(""), ModelJsonError);
});

// Truncation (a max_tokens cut mid-body) is NOT repairable — the object is
// genuinely incomplete. Fail loudly so the caller reports it rather than
// silently persisting half a skill.
test("throws ModelJsonError on truncated JSON rather than guessing", () => {
  assert.throws(() => extractModelJsonObject('{"name":"x","body":"## When to use'), ModelJsonError);
});

test("ModelJsonError carries a bounded snippet for diagnosis", () => {
  try {
    extractModelJsonObject("not json at all");
    assert.fail("expected a throw");
  } catch (err) {
    assert.ok(err instanceof ModelJsonError);
    assert.match(err.message, /not json at all/);
  }
});
