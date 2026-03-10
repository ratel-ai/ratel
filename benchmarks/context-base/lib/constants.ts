export interface ModelPricing {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
}

export const PRICING: Record<string, ModelPricing> = {
  "gpt-5": { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10.0 },
  "gpt-5-mini": { inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 2.0 },
  "gpt-5-nano": { inputPerM: 0.05, cachedInputPerM: 0.005, outputPerM: 0.4 },
  "gpt-5.4": { inputPerM: 2.5, cachedInputPerM: 0.25, outputPerM: 15.0 },
  "gpt-4o": { inputPerM: 2.5, cachedInputPerM: 1.25, outputPerM: 10.0 },
  "claude-sonnet-4-5-20250929": { inputPerM: 3.0, cachedInputPerM: 0.3, outputPerM: 15.0 },
  "claude-haiku-4-5-20251001": { inputPerM: 1.0, cachedInputPerM: 0.1, outputPerM: 5.0 },
  "gemini-3-flash-preview": { inputPerM: 0.5, cachedInputPerM: 0.05, outputPerM: 3.0 },
  "gemini-3-pro-preview": { inputPerM: 2.0, cachedInputPerM: 0.2, outputPerM: 12.0 },
  "claude-sonnet-4-6": { inputPerM: 3.0, cachedInputPerM: 0.3, outputPerM: 15.0 },
  "claude-opus-4-6": { inputPerM: 5.0, cachedInputPerM: 0.5, outputPerM: 25.0 },
};

export function computeCost(input: number, cachedInput: number, output: number, model: string = MODEL): number {
  const pricing = PRICING[model];
  if (!pricing) throw new Error(`Unknown model: ${model}`);
  const nonCachedInput = input - cachedInput;
  return (nonCachedInput * pricing.inputPerM + cachedInput * pricing.cachedInputPerM + output * pricing.outputPerM) / 1_000_000;
}

export const MODEL = process.env.MODEL ?? "gpt-5";
export const MAX_STEPS = 10;
export const SYSTEM_PROMPT = `You are an HR assistant with access to tools.

**Tool usage rules:**
- ALWAYS consider using the tools, do not be afraid of using them. Do not ask confirmation if the plan is clear.
- Use tools to answer factual questions — never guess from memory.
- If a request is outside your capabilities or no relevant tools exist, say so.
- If a tool requires an input you don't have (e.g. employeeId), use agentified_discover to find how to obtain it from information in the user's request.`;
