import { tool } from "ai";
import { z } from "zod";

export const reportingTools = {
  getHeadcount: tool({
    description:
      "Get current headcount with optional breakdown by department, location, or role.",
    inputSchema: z.object({
      groupBy: z
        .enum(["department", "location", "role", "none"])
        .optional()
        .describe("Group results by field"),
    }),
  }),
  getAttrition: tool({
    description:
      "Get attrition rate and details for a given period.",
    inputSchema: z.object({
      period: z.string().describe("Period (e.g. Q1-2024, 2024)"),
      department: z.string().optional().describe("Filter by department"),
    }),
  }),
  generateReport: tool({
    description:
      "Generate a custom HR report with specified metrics and filters.",
    inputSchema: z.object({
      reportType: z
        .enum(["headcount", "attrition", "compensation", "diversity", "custom"])
        .describe("Type of report"),
      period: z.string().describe("Report period"),
      filters: z
        .record(z.string(), z.string())
        .optional()
        .describe("Additional filters"),
      format: z
        .enum(["pdf", "csv", "json"])
        .optional()
        .describe("Output format"),
    }),
  }),
  exportData: tool({
    description:
      "Export HR data in specified format for external analysis.",
    inputSchema: z.object({
      dataType: z
        .enum(["employees", "payroll", "timeoff", "benefits", "all"])
        .describe("Data category to export"),
      format: z.enum(["csv", "json", "xlsx"]).describe("Export format"),
      dateRange: z
        .object({
          start: z.string(),
          end: z.string(),
        })
        .optional()
        .describe("Date range filter"),
    }),
  }),
  getOrgChart: tool({
    description:
      "Get the organizational chart showing reporting hierarchy.",
    inputSchema: z.object({
      department: z
        .string()
        .optional()
        .describe("Show only specific department. By default it's empty and means all the company."),
      depth: z
        .number()
        .optional()
        .describe("Max depth levels to include. By default it's empty and means all the levels."),
    }),
  }),
  getDiversityMetrics: tool({
    description:
      "Get diversity and inclusion metrics across the organization.",
    inputSchema: z.object({
      department: z.string().optional().describe("Filter by department"),
      period: z.string().optional().describe("Report period"),
    }),
  }),
  getCustomDashboard: tool({
    description: "Get a custom analytics dashboard with configurable widgets.",
    inputSchema: z.object({
      dashboardId: z.string().describe("Dashboard ID"),
    }),
  }),
  scheduleReport: tool({
    description: "Schedule a recurring report to be generated and emailed automatically.",
    inputSchema: z.object({
      reportType: z.string().describe("Report type"),
      frequency: z.enum(["daily", "weekly", "monthly", "quarterly"]).describe("Generation frequency"),
      recipients: z.array(z.string()).describe("Recipient email addresses"),
      filters: z.record(z.string(), z.string()).optional().describe("Report filters"),
    }),
  }),
};
