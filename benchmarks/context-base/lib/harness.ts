import type {
  AgentResponse,
  AgentSetupFn,
  BenchmarkOutput,
  DebugInfo,
  Message,
  Scenario,
  SetupParams,
  TestHarness,
  TokenUsage,
} from "./types.js";

export async function loadAgent(
  setup: AgentSetupFn,
  params: SetupParams,
): Promise<TestHarness> {
  return setup(params);
}

export async function runScenario(
  harness: TestHarness,
  scenario: Scenario,
): Promise<BenchmarkOutput> {
  const history: Message[] = [{ role: "user", content: scenario.query }];
  let response = await harness.sendMessage([...history], scenario.seed, scenario.expectedTools);

  if (!scenario.followUps?.length) {
    return { response, scenario };
  }

  const debugTurns: DebugInfo[] = response.debug ? [response.debug] : [];
  let turnId = response.turnId;

  const aggregated: AgentResponse = {
    content: response.content,
    toolCalls: [...response.toolCalls],
    usage: { ...response.usage },
    durationMs: response.durationMs,
    hydratedTools: response.hydratedTools ? [...response.hydratedTools] : undefined,
    turnId,
  };

  for (const followUp of scenario.followUps) {
    history.push({ role: "assistant", content: response.content });
    history.push({ role: "user", content: followUp });
    response = await harness.sendMessage([...history], scenario.seed, scenario.expectedTools, turnId);
    turnId = response.turnId;

    aggregated.content = response.content;
    aggregated.toolCalls.push(...response.toolCalls);
    aggregated.usage = sumUsage(aggregated.usage, response.usage);
    aggregated.durationMs += response.durationMs;
    if (response.hydratedTools) {
      aggregated.hydratedTools = [
        ...new Set([...(aggregated.hydratedTools ?? []), ...response.hydratedTools]),
      ];
    }
    if (response.debug) debugTurns.push(response.debug);
  }

  aggregated.turnId = turnId;

  if (debugTurns.length > 0) {
    aggregated.debug = mergeDebugTurns(debugTurns);
  }

  return { response: aggregated, scenario };
}

function mergeDebugTurns(turns: DebugInfo[]): DebugInfo {
  return {
    systemPrompt: turns[0].systemPrompt,
    toolNames: [...new Set(turns.flatMap((t) => t.toolNames))],
    modelResponse: turns.map((t, i) => `[Turn ${i + 1}] ${t.modelResponse}`).join("\n"),
    toolCallsMade: turns.flatMap((t) => t.toolCallsMade),
  };
}

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens:
      a.cachedInputTokens != null || b.cachedInputTokens != null
        ? (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0)
        : undefined,
  };
}
