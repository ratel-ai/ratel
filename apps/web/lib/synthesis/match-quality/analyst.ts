import Anthropic from "@anthropic-ai/sdk";
import { MAX_DESCRIPTION } from "@/lib/catalog/manage";
import { extractModelJsonObject } from "@/lib/catalog/skills/model-json";
import { type AnalystContext, buildAnalystPrompt } from "./context";
import type { AnalystDiagnosis, AnalystProposal, AnalystResult } from "./types";

/**
 * The one model call a run makes.
 *
 * Pure prompt-build, pure parse, the completion injected, so the prompt and the
 * validation are testable without a live API and the whole pipeline is testable
 * without a key.
 *
 * One call per run, not one per entry. The failures in a catalog are correlated:
 * the dominant pattern in this data is two near-synonym entries whose searchable
 * text never says what makes them different, and an entry-at-a-time prompt cannot
 * see the pair. It also costs twelve calls to reach a worse answer.
 */

/**
 * The deepest model, at high effort, on purpose.
 *
 * This is one call a week per project against a 93-entry catalog, so the cost
 * difference is a few cents a run and roughly twenty dollars a project-year. What
 * it buys is the part that actually went wrong on the first production run:
 * knowing when NOT to cut. The failures there were judgment failures, not
 * knowledge failures, and judgment is what the tier difference pays for.
 *
 * `effort` is set explicitly rather than left at its default, because this is the
 * kind of correlated, whole-catalog reasoning that repays it: the dominant defect
 * in this data is a pair of entries that never say what separates them, and
 * seeing the pair means holding the whole corpus at once.
 */
export const DEFAULT_ANALYST_MODEL = "claude-opus-5";
const ANALYST_EFFORT = "xhigh";

/**
 * Output cap, and it has to cover the THINKING too.
 *
 * This is the one that bit. `max_tokens` bounds everything the model generates,
 * and on Opus 5 adaptive thinking is on by default, so at `xhigh` effort the
 * reasoning alone can eat a budget sized for the answer. 16,000 was ample for
 * Sonnet and truncated a 30-day Opus run four and a half minutes in, mid-JSON.
 *
 * Sized for the reasoning plus twelve full descriptions with rationales, not for
 * the answer alone. The request STREAMS because of it: the SDK's non-streaming
 * timeout is ten minutes and a cap this large can outrun it, which would turn a
 * slow success into a retried failure.
 */
const ANALYST_MAX_TOKENS = 64_000;

const ANALYST_SCHEMA = {
  type: "object",
  properties: {
    diagnosis: {
      type: "object",
      description: "a run-level read for someone with thirty seconds",
      properties: {
        headline: {
          type: "string",
          description: "ONE plain-language sentence naming the single biggest problem, no jargon",
        },
        points: {
          type: "array",
          description: "two to four findings, worst first",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "a few words" },
              detail: {
                type: "string",
                description: "two or three sentences naming the specific entries involved",
              },
            },
            required: ["title", "detail"],
            additionalProperties: false,
          },
        },
      },
      required: ["headline", "points"],
      additionalProperties: false,
    },
    proposals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entryId: {
            type: "string",
            description: "an entry id copied exactly from the supplied catalog",
          },
          searchableDescription: {
            type: "string",
            description: "the full replacement searchable description",
          },
          rationale: {
            type: "string",
            description:
              "ONE sentence, at most 20 words, in plain language, saying WHAT YOU " +
              "CHANGED. No query quotes, no case ids, no jargon (no 'we-missed-it', " +
              "no 'BM25', no 'reference tier'). Example: 'Added the words people " +
              "actually type for this, and said how it differs from list_subtasks.'",
          },
          details: {
            type: "string",
            description:
              "The full audit, for a reader who opens it: which searches this fixes, " +
              "the evidence tier behind each, and — if you shortened anything — " +
              "exactly which phrasings you dropped and why.",
          },
          expectedEffect: { type: "string", description: "one line on what should change" },
        },
        required: ["entryId", "searchableDescription", "rationale", "expectedEffect"],
        additionalProperties: false,
      },
    },
  },
  required: ["diagnosis", "proposals"],
  additionalProperties: false,
} as const;

/** The single model call this needs, injected so generation is testable. */
export interface AnalystDeps {
  model: string;
  complete: (system: string, user: string) => Promise<string>;
}

export interface ParsedAnalystResult extends AnalystResult {
  /** Ids the model returned that are not in the corpus, dropped and reported. */
  rejectedEntryIds: string[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The run-level read, tolerant of the older flat shape.
 *
 * Runs stored before the structured diagnosis shipped hold a bare paragraph, and
 * a model that answers with one anyway should not lose the whole read. Either way
 * the surface gets a headline it can show large and points it can list.
 */
function parseDiagnosis(value: unknown): AnalystDiagnosis {
  if (typeof value === "string") return { headline: value.trim(), points: [] };
  if (typeof value !== "object" || value === null) return { headline: "", points: [] };
  const record = value as Record<string, unknown>;
  const rows = Array.isArray(record.points) ? record.points : [];
  const points = rows
    .map((row) => {
      if (typeof row !== "object" || row === null) return null;
      const entry = row as Record<string, unknown>;
      const title = text(entry.title);
      const detail = text(entry.detail);
      return title || detail ? { title, detail } : null;
    })
    .filter((row): row is { title: string; detail: string } => row !== null);
  return { headline: text(record.headline), points };
}

/**
 * Parse and validate the model's answer against the corpus it was given.
 *
 * Three rules, each of which has a failure mode behind it:
 *
 *  - An `entryId` not in the corpus is DROPPED, not coerced. A hallucinated id
 *    would otherwise reach `setRuntimeCatalogOverride`, which answers 404, so the
 *    apply-all path would half-succeed with no explanation. Dropping it here means
 *    the run reports it instead.
 *  - A proposal identical to the current text is dropped. It is a no-op edit that
 *    would still show up as work for a human to approve.
 *  - Text longer than the column allows is dropped rather than truncated, because
 *    a truncated description is worse than the original.
 */
export function parseAnalystResponse(
  raw: string,
  corpusIds: ReadonlySet<string>,
  currentById: ReadonlyMap<string, string> = new Map(),
): ParsedAnalystResult {
  const parsed = extractModelJsonObject(raw) as Record<string, unknown>;
  const diagnosis = parseDiagnosis(parsed.diagnosis);
  const rejectedEntryIds: string[] = [];
  const proposals: AnalystProposal[] = [];
  const seen = new Set<string>();

  const rows = Array.isArray(parsed.proposals) ? parsed.proposals : [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const entryId = text(record.entryId);
    const searchableDescription = text(record.searchableDescription);
    if (!entryId || !searchableDescription) continue;
    if (!corpusIds.has(entryId)) {
      rejectedEntryIds.push(entryId);
      continue;
    }
    if (seen.has(entryId)) continue;
    if (searchableDescription.length > MAX_DESCRIPTION) {
      rejectedEntryIds.push(entryId);
      continue;
    }
    if (currentById.get(entryId)?.trim() === searchableDescription) continue;
    seen.add(entryId);
    proposals.push({
      entryId,
      searchableDescription,
      rationale: text(record.rationale),
      details: text(record.details),
      expectedEffect: text(record.expectedEffect),
    });
  }

  return { diagnosis, proposals, rejectedEntryIds };
}

/** Anthropic-backed deps. Throws if no API key is configured. */
export function anthropicAnalystDeps(model: string): AnalystDeps {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  const client = new Anthropic({ apiKey });
  return {
    model,
    complete: async (system, user) => {
      const stream = client.messages.stream({
        model,
        max_tokens: ANALYST_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
        output_config: {
          format: { type: "json_schema", schema: ANALYST_SCHEMA },
          effort: ANALYST_EFFORT,
        },
      });
      const msg = await stream.finalMessage();
      // Named at the point they happen, so a failed run says why instead of
      // surfacing an inscrutable JSON syntax error downstream.
      if (msg.stop_reason === "max_tokens") {
        throw new Error(
          `match-quality analysis hit the ${ANALYST_MAX_TOKENS}-token output cap; the answer was truncated`,
        );
      }
      if (msg.stop_reason === "refusal") {
        throw new Error("match-quality analysis was declined by the model's safety filter");
      }
      return msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    },
  };
}

export function defaultAnalystDeps(): AnalystDeps {
  return anthropicAnalystDeps(process.env.ANTHROPIC_MODEL || DEFAULT_ANALYST_MODEL);
}

/** Run the analyst over one assembled context. */
export async function analyse(
  context: AnalystContext,
  deps: AnalystDeps,
): Promise<ParsedAnalystResult> {
  const { system, user } = buildAnalystPrompt(context);
  const raw = await deps.complete(system, user);
  const corpusIds = new Set(context.corpus.map((entry) => entry.entryId));
  const currentById = new Map(context.corpus.map((entry) => [entry.entryId, entry.searchable]));
  return parseAnalystResponse(raw, corpusIds, currentById);
}
