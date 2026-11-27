import {
  type ResolvedDecisionEngine,
  resolveDecisionEngine,
} from "@/lib/readings/decisions/engine";
import { decisionClient } from "@/lib/readings/decisions/openai";
import { type DiffFile, parseUnifiedDiff } from "./diff";
import { type Resolution, type Selection, type SelectionInput, selectEvals } from "./select";

/**
 * The second pass of the change → evals rule: the files the rule leaves unmapped (code that names
 * no tool and no eval path) go to the decision engine, which reads each one as one tool's code, as
 * not the agent's (a website, other tooling), or as code every run goes through. Only an answer at
 * or above the confidence floor counts; anything else, no engine, or an engine that fails, leaves
 * the rule's answer: unmapped runs every eval.
 */

/** What the model reads in one file; null when it cannot tell. */
export type ChangeClassifier = (
  file: Pick<DiffFile, "path" | "added" | "removed">,
  tools: string[],
) => Promise<Resolution | null>;

/** Files asked about per commit: a large change runs everything anyway. */
export const MAX_CLASSIFIED_FILES = 20;

export async function selectEvalsWithModel(
  input: SelectionInput,
  classify: ChangeClassifier | null,
  options: { maxFiles?: number } = {},
): Promise<Selection> {
  const files = typeof input.diff === "string" ? parseUnifiedDiff(input.diff) : input.diff;
  const first = selectEvals({ ...input, diff: files });
  if (!classify || first.change.unmapped.length === 0) return first;

  const asked = first.change.unmapped.slice(0, options.maxFiles ?? MAX_CLASSIFIED_FILES);
  const resolved: Record<string, Resolution> = { ...input.resolved };
  for (const path of asked) {
    const file = files.find((f) => f.path === path);
    if (!file) continue;
    const resolution = await classify(file, input.tools).catch(() => null);
    if (resolution) resolved[path] = resolution;
  }
  return selectEvals({ ...input, diff: files, resolved });
}

/** One question as the decision engine takes it (`readings/decisions/openai.ts`). */
type DecisionRequest = {
  input: string;
  instructions: string;
  options: readonly { id: string; does: string }[];
};
type DecisionAsk = (request: DecisionRequest) => Promise<{
  answer: { choice: string; confidence: number } | "refusal";
  inputTokens: number;
}>;

/** Below it, the model's reading is not used. */
export const MIN_CONFIDENCE = 0.8;
const MAX_INPUT_CHARS = 4_000;

const INSTRUCTIONS =
  "A commit changed this file in the repository of an AI agent. The options are the agent's " +
  "tools, code that is not the agent's, and code every run of the agent goes through. Pick the " +
  "one part of the agent the change affects.";

/** A classifier over the decision engine's `ask`: one closed question per file. */
export function decisionClassifier(
  ask: DecisionAsk,
  minConfidence = MIN_CONFIDENCE,
): ChangeClassifier {
  return async (file, tools) => {
    const lines = [
      ...file.removed.map((line) => `-${line}`),
      ...file.added.map((line) => `+${line}`),
    ];
    const input = `File: ${file.path}\n${lines.join("\n")}`.slice(0, MAX_INPUT_CHARS);
    const { answer } = await ask({
      input,
      instructions: INSTRUCTIONS,
      options: [
        ...tools.map((tool) => ({
          id: `tool:${tool}`,
          does: `The code of the agent's tool ${tool}: what it does when the agent calls it.`,
        })),
        {
          id: "outside",
          does: "Not the agent: a website, its content, another app, build or developer tooling.",
        },
        {
          id: "shared",
          does: "Code every run goes through: the agent loop, the model call, shared helpers.",
        },
      ],
    });
    if (answer === "refusal" || answer.confidence < minConfidence) return null;
    if (answer.choice === "outside" || answer.choice === "shared") {
      return { kind: answer.choice, confidence: answer.confidence };
    }
    if (answer.choice.startsWith("tool:")) {
      return {
        kind: "tool",
        tool: answer.choice.slice("tool:".length),
        confidence: answer.confidence,
      };
    }
    return null;
  };
}

/**
 * The classifier over this deployment's decision engine, or null without one (no
 * `OPENAI_API_KEY`): then nothing calls out and unmapped code runs every eval. Its questions are
 * charged to the customer, as Tool Picker's are.
 */
export function engineClassifier(
  engine: () => ResolvedDecisionEngine | null = resolveDecisionEngine,
  fetchImpl?: typeof fetch,
): ChangeClassifier | null {
  const resolved = engine();
  if (!resolved) return null;
  const client = decisionClient({
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    feature: "change_selection",
    payer: "customer",
    timeoutMs: 10_000,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return decisionClassifier((request) => client.ask(request));
}
