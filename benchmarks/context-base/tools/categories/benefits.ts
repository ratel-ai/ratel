import { tool } from "ai";
import { z } from "zod";

export const benefitsTools = {
  enrollBenefits: tool({
    description:
      "Enroll an employee in one or more benefit plans. Requires employee ID - use searchEmployees first to find the employee.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      planIds: z.array(z.string()).describe("Benefit plan IDs to enroll in"),
      effectiveDate: z
        .string()
        .optional()
        .describe("Enrollment effective date (YYYY-MM-DD)"),
    }),
  }),
  getBenefitOptions: tool({
    description:
      "Get available benefit plans and options for an employee. Requires employee ID - use searchEmployees first to find the employee by name. Returns plans based on eligibility.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      category: z
        .enum(["health", "dental", "vision", "retirement", "all"])
        .optional()
        .describe("Benefit category filter"),
    }),
  }),
  updateBenefitElection: tool({
    description: "Update an employee's existing benefit election.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      planId: z.string().describe("Plan ID to update"),
      changes: z.record(z.string(), z.unknown()).describe("Fields to update"),
    }),
  }),
  calculateBenefitCost: tool({
    description:
      "Calculate the cost of a benefit plan for an employee (employee + employer contributions).",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      planId: z.string().describe("Benefit plan ID"),
    }),
  }),
  getEnrolledBenefits: tool({
    description: "Get all benefit plans an employee is currently enrolled in. Requires employee ID - use searchEmployees first to find the employee by name.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
    }),
  }),
  compareBenefitPlans: tool({
    description: "Compare two or more benefit plans side by side.",
    inputSchema: z.object({
      planIds: z.array(z.string()).describe("Plan IDs to compare"),
    }),
  }),
  getBenefitsCost: tool({
    description: "Get total benefits cost summary for an employee across all enrolled plans.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
    }),
  }),
};
