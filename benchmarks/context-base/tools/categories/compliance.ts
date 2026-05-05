import { tool } from "ai";
import { z } from "zod";

export const complianceTools = {
  runComplianceCheck: tool({
    description:
      'Run a compliance check for an employee or department. Returns violations found.',
    inputSchema: z.object({
      employeeId: z.string().optional().describe("Check specific employee"),
      department: z.string().optional().describe("Check entire department"),
      checkType: z
        .enum(["i9", "background", "training", "all"])
        .optional()
        .describe("Type of compliance check"),
    }),
  }),
  getAuditLog: tool({
    description:
      'Get audit log entries with optional filters by date range, user, or action type.',
    inputSchema: z.object({
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      endDate: z.string().optional().describe("End date (YYYY-MM-DD)"),
      userId: z.string().optional().describe("Filter by user ID"),
      action: z.string().optional().describe("Filter by action type"),
    }),
  }),
  generateComplianceReport: tool({
    description:
      'Generate a compliance report for a given period covering all departments.',
    inputSchema: z.object({
      period: z.string().describe("Report period (e.g. Q1-2024, 2024)"),
      format: z
        .enum(["pdf", "csv", "json"])
        .optional()
        .describe("Output format"),
    }),
  }),
  flagViolation: tool({
    description:
      'Flag a compliance violation for review',
    inputSchema: z.object({
      employeeId: z.string().optional().describe("Employee involved"),
      violationType: z.enum(['i10', 'a1', 'a2', 'b6', 'xyz', 'i9', 'ab5', 'l9', 'hh', 'kl', 'ko']).describe("Type of violation"),
      description: z.string().describe("Description of the violation"),
      severity: z
        .enum(["low", "medium", "high", "critical"])
        .optional()
        .describe("Severity level"),
    }),
  }),
  getComplianceStatus: tool({
    description:
      'Get overall compliance status summary for the organization.',
    inputSchema: z.object({
      department: z.string().optional().describe("Filter by department"),
    }),
  }),
  acknowledgePolicy: tool({
    description:
      'Record an employee\'s acknowledgment of a compliance policy.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      policyId: z.string().describe("Policy ID"),
    }),
  }),
};
