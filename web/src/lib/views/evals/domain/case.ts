import { z } from "zod";
import {
  CHECK_OPERATORS,
  isComparable,
  isTrialCheckPath,
  MAX_PATH_CHARS,
  MAX_VALUE_CHARS,
} from "@/lib/contracts/check";
import type { ScorerDefinition } from "@/lib/views/scorers/types";

export type VersionState = "draft" | "approved";

const MAX_NAME_CHARS = 200;
const MAX_LABELS = 20;
const MAX_QUESTION_CHARS = 5_000;
const MAX_SCORERS = 50;
export const MAX_CONTENT_CHARS = 256 * 1024;

const checkSchema = z
  .object({
    path: z.string().trim().max(MAX_PATH_CHARS).refine(isTrialCheckPath, "choose what to read"),
    op: z.enum(CHECK_OPERATORS),
    value: z.union([z.string().min(1).max(MAX_VALUE_CHARS), z.number(), z.boolean()]).optional(),
  })
  .refine(({ op, value }) => op === "exists" || value !== undefined, {
    message: "give the check a value to compare with",
  })
  .refine(({ op, value }) => value === undefined || isComparable(op, value), {
    message: "this operator compares with a number",
  });

/** A judge of evals answers yes or no. */
const judgeSchema = z.object({
  prompt: z.string().trim().min(1, "write the question").max(MAX_QUESTION_CHARS),
  output: z.literal("boolean"),
});

const definitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check"), config: checkSchema }),
  z.object({ kind: z.literal("judge"), config: judgeSchema }),
]) satisfies z.ZodType<ScorerDefinition>;

/** A scorer of a case: the shared definition, and whether it decides the result of a trial. */
const caseScorerSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  gating: z.boolean(),
  definition: definitionSchema,
});
export type CaseScorer = z.infer<typeof caseScorerSchema>;

const toolFixtureSchema = z.object({
  tool: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  // JSON has no undefined: a fixture that the runner can match needs both.
  arguments: z.unknown().transform((value) => value ?? null),
  result: z.unknown().transform((value) => value ?? null),
});

const earlierTurnSchema = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });
export type EarlierTurn = z.infer<typeof earlierTurnSchema>;

/** What a version freezes. */
export const caseContentSchema = z
  .object({
    input: z.unknown().transform((value) => value ?? null),
    earlierTurns: z.array(earlierTurnSchema).max(200).default([]),
    toolFixtures: z.array(toolFixtureSchema).max(200).default([]),
    expectedOutput: z.string().nullable().default(null),
    scorers: z
      .array(caseScorerSchema)
      .max(MAX_SCORERS)
      .refine(
        (scorers) => new Set(scorers.map(({ id }) => id)).size === scorers.length,
        "two scorers have the same id",
      )
      .default([]),
  })
  .refine(
    (content) => JSON.stringify(content).length <= MAX_CONTENT_CHARS,
    "the case is too large",
  );
export type CaseContent = z.infer<typeof caseContentSchema>;

/** A task or an intent is only a label. */
export const caseDetailsSchema = z.object({
  name: z.string().trim().min(1, "give the case a name").max(MAX_NAME_CHARS),
  labels: z
    .array(z.string().trim().min(1).max(100))
    .max(MAX_LABELS)
    .transform((labels) => [...new Set(labels)])
    .default([]),
});
export type CaseDetails = z.infer<typeof caseDetailsSchema>;

export type CaseVersion = CaseContent & {
  id: string;
  caseId: string;
  number: number;
  state: VersionState;
  /** The turn that the case was saved from. */
  sourceTurnId: string | null;
  /** What the agent answered in that turn. No scorer reads it. */
  sourceOutput: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  updatedAt: Date;
};

export type EvalCase = CaseDetails & {
  id: string;
  projectId: string;
  createdAt: Date;
  /** The newest first. */
  versions: CaseVersion[];
};

/** The version that counts: the newest approved one. */
export function approvedVersion(evalCase: Pick<EvalCase, "versions">): CaseVersion | null {
  return evalCase.versions.find(({ state }) => state === "approved") ?? null;
}

export function draftVersion(evalCase: Pick<EvalCase, "versions">): CaseVersion | null {
  return evalCase.versions.find(({ state }) => state === "draft") ?? null;
}

/** Why a version cannot be approved, or null. With no gating scorer each trial would pass. */
export function approvalProblem(content: Pick<CaseContent, "input" | "scorers">): string | null {
  if (content.input === null) return "Give the case an input.";
  if (!content.scorers.some(({ gating }) => gating)) return "Make at least one scorer gating.";
  return null;
}
