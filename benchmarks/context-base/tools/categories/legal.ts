import { tool } from "ai";
import { z } from "zod";

export const legalTools = {
  createLegalContract: tool({
    description: "Create a new legal contract (employment, service, partnership, etc.).",
    inputSchema: z.object({
      type: z.enum(["employment", "service", "partnership", "licensing", "other"]).describe("Contract type"),
      title: z.string().describe("Contract title"),
      parties: z.array(z.string()).describe("Contract parties"),
      startDate: z.string().describe("Contract start date (YYYY-MM-DD)"),
      endDate: z.string().optional().describe("Contract end date (YYYY-MM-DD)"),
      value: z.number().optional().describe("Contract value"),
    }),
  }),
  getLegalContract: tool({
    description: "Get legal contract details by contract ID.",
    inputSchema: z.object({
      contractId: z.string().describe("Contract ID"),
    }),
  }),
  listLegalContracts: tool({
    description: "List legal contracts with optional filters.",
    inputSchema: z.object({
      type: z.enum(["employment", "service", "partnership", "licensing", "other", "all"]).optional().describe("Contract type filter"),
      status: z.enum(["draft", "active", "expired", "terminated", "all"]).optional().describe("Status filter"),
    }),
  }),
  requestContractReview: tool({
    description: "Submit a contract for legal review and approval.",
    inputSchema: z.object({
      contractId: z.string().describe("Contract ID"),
      requesterId: z.string().describe("Requester employee ID"),
      urgency: z.enum(["standard", "expedited", "urgent"]).optional().describe("Review urgency"),
      notes: z.string().optional().describe("Review notes"),
    }),
  }),
  getContractReviewStatus: tool({
    description: "Get the status of a contract review request.",
    inputSchema: z.object({
      reviewId: z.string().describe("Review request ID"),
    }),
  }),
  createNDA: tool({
    description: "Create a non-disclosure agreement.",
    inputSchema: z.object({
      parties: z.array(z.string()).describe("NDA parties"),
      scope: z.string().describe("Scope of confidentiality"),
      duration: z.string().describe("NDA duration (e.g. 2 years)"),
      effectiveDate: z.string().describe("Effective date (YYYY-MM-DD)"),
    }),
  }),
  getNDA: tool({
    description: "Get NDA details by NDA ID.",
    inputSchema: z.object({
      ndaId: z.string().describe("NDA ID"),
    }),
  }),
  listNDAs: tool({
    description: "List non-disclosure agreements with optional filters.",
    inputSchema: z.object({
      status: z.enum(["active", "expired", "all"]).optional().describe("Status filter"),
      party: z.string().optional().describe("Filter by party name"),
    }),
  }),
  getPolicy: tool({
    description: "Get company policy document by ID.",
    inputSchema: z.object({
      policyId: z.string().describe("Policy ID"),
    }),
  }),
  listPolicies: tool({
    description: "List company policies with optional category filter.",
    inputSchema: z.object({
      category: z.string().optional().describe("Policy category (e.g. HR, IT, Finance)"),
      status: z.enum(["active", "draft", "archived", "all"]).optional().describe("Status filter"),
    }),
  }),
  updatePolicy: tool({
    description: "Update a company policy document.",
    inputSchema: z.object({
      policyId: z.string().describe("Policy ID"),
      title: z.string().optional().describe("Updated title"),
      content: z.string().optional().describe("Updated content"),
      effectiveDate: z.string().optional().describe("New effective date"),
    }),
  }),
  generateLegalReport: tool({
    description: "Generate a legal department report covering contracts, NDAs, and compliance.",
    inputSchema: z.object({
      period: z.string().describe("Report period (e.g. Q1-2025)"),
      format: z.enum(["pdf", "csv", "json"]).optional().describe("Output format"),
    }),
  }),
};
