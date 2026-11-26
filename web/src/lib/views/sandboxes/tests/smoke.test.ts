import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeCommandAnswer, judgeHttpAnswer, redact, smokeRequest, tailOf } from "../domain/smoke";

test("the smoke request runs the example with the default params and every tool simulated", () => {
  const request = smokeRequest(
    {
      name: "a",
      input: { example: { message: "Refund order 42" } },
      params: {
        model: { type: "enum", options: ["x", "y"], default: "y" },
        tone: { type: "string" },
        verbose: { type: "boolean", default: false },
      },
      tools: { lookup_order: { mode: "live" }, refund_order: {} },
    },
    "run-1",
  );
  assert.deepEqual(request, {
    v: 1,
    runId: "run-1",
    input: { message: "Refund order 42" },
    params: { model: "y", verbose: false },
    tools: { lookup_order: { mode: "simulated" }, refund_order: { mode: "simulated" } },
    fixtures: [],
  });
});

test("an HTTP answer: 200 with a run response is ok, each other answer has its contract code", () => {
  assert.deepEqual(judgeHttpAnswer(200, '{"output":{"reply":"done"}}'), {
    ok: true,
    output: { reply: "done" },
  });
  assert.deepEqual(judgeHttpAnswer(200, '{"output":null}'), { ok: true, output: null });
  const code = (status: number, body: string) => {
    const answer = judgeHttpAnswer(status, body);
    return answer.ok ? "ok" : answer.error.code;
  };
  assert.equal(code(200, "<html>"), "not_json");
  assert.equal(code(200, '{"reply":"done"}'), "invalid_response");
  assert.equal(code(200, '{"output":1,"toolCalls":[{"name":"x","args":{}}]}'), "invalid_response");
  assert.equal(code(500, "Internal Server Error"), "invalid_error");
  assert.equal(code(500, '{"error":"run_failed"}'), "invalid_error");
  assert.deepEqual(judgeHttpAnswer(500, '{"error":{"code":"run_failed","message":"No model."}}'), {
    ok: false,
    error: { code: "run_failed", message: "No model." },
  });
});

test("a command answer: a JSON object with output is a run response, other text is the output", () => {
  assert.deepEqual(judgeCommandAnswer(0, '{"output":"hi"}\n'), { ok: true, output: "hi" });
  assert.deepEqual(judgeCommandAnswer(0, "plain text\n"), { ok: true, output: "plain text" });
  assert.deepEqual(judgeCommandAnswer(0, '{"reply":1}'), { ok: true, output: '{"reply":1}' });
  const bad = judgeCommandAnswer(0, '{"output":1,"usage":{"inputTokens":-1}}');
  assert.equal(!bad.ok && bad.error.code, "invalid_response");
  const failed = judgeCommandAnswer(3, "");
  assert.equal(!failed.ok && failed.error.code, "run_failed");
  assert.match(!failed.ok ? failed.error.message : "", /code 3/);
});

test("logs lose each secret value and keep their end", () => {
  assert.equal(
    redact("key=abc123 and abc", ["abc123", "abc", ""]),
    "key=[redacted] and [redacted]",
  );
  const long = `${"x".repeat(70_000)}END`;
  const tail = tailOf(long);
  assert.equal(tail.length, 64 * 1024);
  assert.ok(tail.endsWith("END"));
  assert.equal(tailOf("a\0b"), "ab");
});
