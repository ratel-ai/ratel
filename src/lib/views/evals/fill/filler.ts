import { z } from "zod";
import {
  mockModelsEnabled,
  resolveSpecFillModel,
  type SpecFillModel,
  STAND_IN_MODEL,
} from "@/lib/views/eval-gate/models";
import type { EvalMessage, EvalSpecField, EvalTool } from "../domain/types";

/**
 * RC-608: the spec filler port. It writes the parts of an eval's spec that the
 * recording lacks: only the fields in `missing`. Adapters: the small Claude
 * model (`modelSpecFiller`) and a scripted stand-in for `EVAL_GATE_MOCK_MODEL=1`.
 */

export interface FillRequest {
  missing: readonly EvalSpecField[];
  name: string;
  criteria: string;
  expectedTool: string | null;
  earlierMessages: readonly EvalMessage[];
  /** What the eval has already. */
  given: {
    systemPrompt: string | null;
    message: string;
    tools: readonly EvalTool[] | null;
    context: Readonly<Record<string, string>> | null;
  };
}

export interface FilledValues {
  systemPrompt?: string;
  message?: string;
  tools?: EvalTool[];
  context?: Record<string, string>;
}

export interface SpecFiller {
  model: string;
  /** Throws when the model fails or answers malformed JSON. */
  fill(request: FillRequest): Promise<FilledValues>;
}

/** The deployment's filler: scripted locally, the small Claude model, else none (no key). */
export function resolveSpecFiller(
  env: Record<string, string | undefined> = process.env,
): SpecFiller | null {
  if (mockModelsEnabled(env)) return scriptedSpecFiller();
  const model = resolveSpecFillModel(env);
  return model ? modelSpecFiller(model) : null;
}

/** The filler through a spec-fill model: the request as JSON in, the values parsed out. */
export function modelSpecFiller(model: SpecFillModel): SpecFiller {
  return {
    model: model.model,
    async fill(request) {
      const reply = await model.fill(JSON.stringify(request));
      return parseFilled(reply.text);
    },
  };
}

/** A local stand-in that writes a plausible spec from the eval's own fields, with no model. */
export function scriptedSpecFiller(): SpecFiller {
  return {
    model: STAND_IN_MODEL,
    async fill({ name, expectedTool }) {
      const tool = expectedTool ?? "lookup";
      return {
        systemPrompt: `You are the agent under test. Handle the user's request with the tools you are offered. (Local stand-in spec for "${name}".)`,
        message: name || "Complete the recorded task.",
        tools: [
          {
            name: tool,
            description: `Local stand-in for ${tool}.`,
            parameters: { type: "object", properties: { id: { type: "string" } } },
          },
        ],
        context: { id: "LOCAL-1" },
      };
    },
  };
}

const toolSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(2000).optional().default(""),
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .default({ type: "object", properties: {} }),
});

/** The values in a filler's JSON answer that are well formed; others are dropped. Throws when the answer isn't a JSON object. */
export function parseFilled(text: string): FilledValues {
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("the spec filler answered no JSON object");
  const raw = value as Record<string, unknown>;
  const out: FilledValues = {};
  if (typeof raw.systemPrompt === "string") out.systemPrompt = raw.systemPrompt.slice(0, 4000);
  if (typeof raw.message === "string") out.message = raw.message.slice(0, 2000);
  if (Array.isArray(raw.tools))
    out.tools = raw.tools
      .flatMap((item) => {
        const parsed = toolSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
      .slice(0, 8);
  if (raw.context && typeof raw.context === "object" && !Array.isArray(raw.context)) {
    out.context = Object.fromEntries(
      Object.entries(raw.context as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .slice(0, 10),
    );
  }
  return out;
}
