import { z } from "zod"
import type { Capability, DecisionGraph, InvocationContext, DecisionNode } from "../types"

export const SearchDecisionsArgsSchema = z.object({
  query: z.string().describe("Search query"),
  limit: z.number().optional().describe("Max results to return"),
  entities: z.array(z.string()).optional().describe("Filter by entities"),
})

export type SearchDecisionsArgs = z.infer<typeof SearchDecisionsArgsSchema>

export const LearnArgsSchema = z.object({
  rule: z.string().describe("The rule or constraint learned"),
  evidence: z.array(z.string()).describe("IDs of decisions that led to this learning"),
  appliesTo: z.string().optional().describe("Capability this constraint applies to"),
})

export type LearnArgs = z.infer<typeof LearnArgsSchema>

export function createSearchDecisionsCapability(
  decisionGraph: DecisionGraph
): Capability<SearchDecisionsArgs, DecisionNode[]> {
  return {
    name: "search_decisions",
    description: "Search past decisions for relevant context and precedents",
    schema: SearchDecisionsArgsSchema,
    fn: async (args) => {
      return decisionGraph.search(args.query, {
        limit: args.limit,
        entities: args.entities,
      })
    },
  }
}

export function createLearnCapability(
  decisionGraph: DecisionGraph
): Capability<LearnArgs, DecisionNode> {
  return {
    name: "learn",
    description: "Save a learning or constraint discovered through experience",
    schema: LearnArgsSchema,
    fn: async (args, context: InvocationContext) => {
      if (args.appliesTo) {
        return decisionGraph.addNode({
          type: "constraint",
          condition: args.rule,
          appliesTo: args.appliesTo,
          sessionId: context.sessionId,
        })
      }
      return decisionGraph.addNode({
        type: "learning",
        rule: args.rule,
        evidence: args.evidence,
        sessionId: context.sessionId,
      })
    },
  }
}

// In-memory decision graph for testing/development
export function createInMemoryDecisionGraph(): DecisionGraph {
  const nodes: DecisionNode[] = []

  return {
    async search(query, options) {
      const limit = options?.limit ?? 10
      // Simple substring matching for now
      const matches = nodes.filter((node) => {
        const text = JSON.stringify(node).toLowerCase()
        return text.includes(query.toLowerCase())
      })
      return matches.slice(0, limit)
    },

    async addNode(partial) {
      const node = {
        ...partial,
        id: crypto.randomUUID(),
        timestamp: new Date(),
      } as DecisionNode
      nodes.push(node)
      return node
    },

    async getById(id) {
      return nodes.find((n) => n.id === id) ?? null
    },
  }
}
