import assert from "node:assert/strict";
import { test } from "node:test";
import { evalJudgeContract } from "@/lib/contracts/eval-judge.contract";
import { createDecisionJudge } from "../adapters/decision-judge";

evalJudgeContract("the core's decision engine", ({ fetchImpl }) =>
  createDecisionJudge(
    () => ({ name: "openai", apiKey: "sk-test", baseUrl: "http://decisions" }),
    fetchImpl,
  ),
);

test("with no engine configured there is no judge and no outbound call", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response();
  }) as typeof fetch;
  const port = createDecisionJudge(() => null, fetchImpl);
  assert.equal(await port.judgeFor({ organizationId: "o", projectId: "p" }), null);
  assert.equal(calls, 0);
});
