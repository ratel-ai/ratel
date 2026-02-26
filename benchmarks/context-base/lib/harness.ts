import { spawn, type ChildProcess } from "node:child_process";
import type {
  AgentResponse,
  BenchmarkOutput,
  DebugInfo,
  Message,
  Scenario,
  TestHarness,
  TokenUsage,
} from "./types.js";
import type { SetupBody, SendMessageResponse } from "./protocol.js";

export interface AgentProcess {
  child: ChildProcess;
  port: number;
}

export function createHttpHarness(port: number): TestHarness {
  return {
    sendMessage: async (history, seed, expectedTools, turnId) => {
      const res = await fetch(`http://localhost:${port}/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history, seed, expectedTools, turnId }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`send-message failed: ${res.status} ${errBody}`);
      }
      const data: SendMessageResponse = await res.json();
      return {
        content: data.content,
        toolCalls: data.toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        })),
        usage: data.usage,
        durationMs: data.durationMs,
        hydratedTools: data.hydratedTools,
        turnId: data.turnId,
        debug: data.debug,
      };
    },
  };
}

export async function spawnAgent(cmd: string, port: number): Promise<AgentProcess> {
  const parts = cmd.split(" ");
  const child = spawn(parts[0], parts.slice(1), {
    env: { ...process.env, AGENT_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr?.on("data", (data: Buffer) => {
    if (process.env.DEBUG) process.stderr.write(`[agent:${port}] ${data}`);
  });

  await waitForHealth(`http://localhost:${port}/health`, 30_000);
  return { child, port };
}

export async function sendSetup(port: number, body: SetupBody): Promise<void> {
  const res = await fetch(`http://localhost:${port}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Setup failed (${res.status}): ${text}`);
  }
}

export async function killAgent(agent: AgentProcess): Promise<void> {
  agent.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    agent.child.on("close", resolve);
    setTimeout(() => {
      agent.child.kill("SIGKILL");
      resolve();
    }, 5_000);
  });
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

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Agent health check timed out after ${timeoutMs}ms`);
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
