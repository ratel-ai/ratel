import { z } from "zod";

const limit = z.number().finite().nonnegative().nullable();
export const testProposalSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/),
    ask: z.string().trim().min(1).max(10000),
    expected: z
      .object({
        tool: z.string().trim().min(1).max(500).nullable(),
        maxToolCalls: z.number().int().nonnegative().nullable(),
        maxSelfCorrections: z.number().int().nonnegative().nullable(),
        maxLatencyMs: limit,
        maxCostUsd: limit,
      })
      .strict(),
    criteria: z.string().trim().min(1).max(5000),
  })
  .strict();
export type TestProposal = z.infer<typeof testProposalSchema>;
