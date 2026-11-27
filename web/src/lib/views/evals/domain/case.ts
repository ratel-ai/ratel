import { z } from "zod";

export type VersionState = "draft" | "approved";

const MAX_NAME_CHARS = 200;
const MAX_LABELS = 20;
export const MAX_LIST = 200;
/** The tool names that a sandbox can declare. */
export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_CONTENT_CHARS = 256 * 1024;

const toolFixtureSchema = z.object({
  tool: z.string().regex(TOOL_NAME),
  // JSON has no undefined: a fixture that the runner can match needs both.
  arguments: z.unknown().transform((value) => value ?? null),
  result: z.unknown().transform((value) => value ?? null),
});

const earlierTurnSchema = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });
export type EarlierTurn = z.infer<typeof earlierTurnSchema>;

/** What a version freezes: a row of the dataset of an eval. The eval has the scorers. */
export const caseContentSchema = z
  .object({
    input: z.unknown().transform((value) => value ?? null),
    earlierTurns: z.array(earlierTurnSchema).max(MAX_LIST).default([]),
    toolFixtures: z.array(toolFixtureSchema).max(MAX_LIST).default([]),
    expectedOutput: z.string().nullable().default(null),
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
  /** The eval whose dataset has the case. */
  evalId: string;
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

/** Why a version cannot be approved, or null. The scorers are the eval's (`eval.ts#runProblem`). */
export function approvalProblem(content: Pick<CaseContent, "input">): string | null {
  return content.input === null ? "Give the case an input." : null;
}

/**
 * The input that a run of the case gets. The earlier turns of the conversation are part of it, as
 * `messages` (`{ role, content }`, as in `protocol/sandbox/v1`). An object input gets the field next
 * to its own fields. Any other input, and an object that has `messages` already, goes in `value`.
 */
export function runInputOf(version: Pick<CaseContent, "input" | "earlierTurns">): unknown {
  const { input, earlierTurns } = version;
  if (earlierTurns.length === 0) return input;
  const messages = earlierTurns.map(({ role, text }) => ({ role, content: text }));
  const isRecord = typeof input === "object" && input !== null && !Array.isArray(input);
  if (isRecord && !Object.hasOwn(input, "messages")) return { ...input, messages };
  return { value: input, messages };
}
