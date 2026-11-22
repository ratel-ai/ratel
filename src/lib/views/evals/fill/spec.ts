import { getLogger } from "@/lib/platform/logger";
import type { EvalMessage, EvalSpecField, EvalTool } from "../domain/types";
import type { CapturedSpec } from "./captured";
import type { SpecFiller } from "./filler";

/**
 * RC-608: an eval's complete spec at creation. The recording's values win;
 * the filler writes only what is missing, and `generated` names exactly the
 * fields it wrote. A failing filler costs nothing but the fill: the eval keeps
 * what was captured, with `generated` empty.
 */

export interface SpecDraft {
  name: string;
  message: string;
  criteria: string;
  expectedTool: string | null;
  earlierMessages: readonly EvalMessage[];
  /** What the run's recording holds; null when there is no recording. */
  captured: CapturedSpec | null;
}

export interface CompleteSpec {
  systemPrompt: string | null;
  message: string;
  tools: EvalTool[] | null;
  context: Record<string, string> | null;
  generated: EvalSpecField[];
}

const logger = getLogger("evals/fill");

/** The draft's spec with its missing fields filled (when a filler is given). */
export async function completeSpec(
  draft: SpecDraft,
  filler: SpecFiller | null,
): Promise<CompleteSpec> {
  const spec: CompleteSpec = {
    systemPrompt: draft.captured?.systemPrompt ?? null,
    message: draft.message,
    tools: draft.captured?.tools ?? null,
    context: draft.captured?.context ?? null,
    generated: [],
  };
  const missing = missingFields(spec);
  if (!filler || missing.length === 0) return spec;
  // Owned: typed for the core's lint (noImplicitAnyLet); otherwise upstream's.
  let filled: Awaited<ReturnType<SpecFiller["fill"]>>;
  try {
    filled = await filler.fill({
      missing,
      name: draft.name,
      criteria: draft.criteria,
      expectedTool: draft.expectedTool,
      earlierMessages: draft.earlierMessages,
      given: {
        systemPrompt: spec.systemPrompt,
        message: spec.message,
        tools: spec.tools,
        context: spec.context,
      },
    });
  } catch (err) {
    logger.warn({ err, model: filler.model, missing }, "eval spec fill failed");
    return spec;
  }
  for (const field of missing) {
    if (field === "systemPrompt" && filled.systemPrompt?.trim())
      spec.systemPrompt = filled.systemPrompt.trim();
    else if (field === "message" && filled.message?.trim()) spec.message = filled.message.trim();
    else if (field === "tools" && filled.tools && filled.tools.length > 0)
      spec.tools = filled.tools;
    else if (field === "context" && filled.context) spec.context = filled.context;
    else continue;
    spec.generated.push(field);
  }
  return spec;
}

/** The fields with no usable value: a blank prompt or message, no tools, no context. */
function missingFields(spec: CompleteSpec): EvalSpecField[] {
  const missing: EvalSpecField[] = [];
  if (!spec.systemPrompt?.trim()) missing.push("systemPrompt");
  if (!spec.message.trim()) missing.push("message");
  if (!spec.tools || spec.tools.length === 0) missing.push("tools");
  if (!spec.context) missing.push("context");
  return missing;
}
