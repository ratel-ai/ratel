import { tool } from "ai";
import { z } from "zod";

export const timeoffTools = {
  getTimeOffBalance: tool({
    description:
      'Get remaining time-off/vacation days balance for an employee. Requires employee ID - use searchEmployees first to find the employee by name. Returns balance by type (vacation, sick, personal).',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      type: z
        .enum(["vacation", "sick", "personal", "all"])
        .optional()
        .describe("Leave type filter"),
    }),
  }),
  requestTimeOff: tool({
    description:
      'Submit a time-off request for an employee.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      type: z
        .enum(["vacation", "sick", "personal"])
        .describe("Leave type"),
      startDate: z.string().describe("Start date (YYYY-MM-DD)"),
      endDate: z.string().describe("End date (YYYY-MM-DD)"),
      reason: z.string().optional().describe("Reason for time off"),
    }),
  }),
  approveTimeOff: tool({
    description:
      'Approve a pending time-off request.',
    inputSchema: z.object({
      requestId: z.string().describe("Time-off request ID"),
      approverId: z.string().describe("Approver employee ID"),
      comment: z.string().optional().describe("Approval comment"),
    }),
  }),
  denyTimeOff: tool({
    description:
      'Deny a pending time-off request.',
    inputSchema: z.object({
      requestId: z.string().describe("Time-off request ID"),
      approverId: z.string().describe("Approver employee ID"),
      reason: z.string().describe("Reason for denial"),
    }),
  }),
  getPendingTimeOff: tool({
    description:
      'List all pending time-off requests. Can filter by department or employee ID. Use searchEmployees first if filtering by a specific person.',
    inputSchema: z.object({
      department: z.string().optional().describe("Filter by department"),
      employeeId: z.string().optional().describe("Filter by employee"),
    }),
  }),
  getTimeOffHistory: tool({
    description:
      'Get historical time-off records for an employee.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      year: z.number().optional().describe("Filter by year"),
    }),
  }),
  cancelTimeOff: tool({
    description:
      'Cancel an approved or pending time-off request.',
    inputSchema: z.object({
      requestId: z.string().describe("Time-off request ID"),
      reason: z.string().optional().describe("Cancellation reason"),
    }),
  }),
  getTeamCalendar: tool({
    description:
      'Get team calendar showing who is off during a date range.',
    inputSchema: z.object({
      department: z.string().describe("Department name"),
      startDate: z.string().describe("Range start (YYYY-MM-DD)"),
      endDate: z.string().describe("Range end (YYYY-MM-DD)"),
    }),
  }),
  getHolidayCalendar: tool({
    description:
      'Get the company holiday calendar for a given year.',
    inputSchema: z.object({
      year: z.number().describe("Calendar year"),
      country: z.string().optional().describe("Country code for regional holidays"),
    }),
  }),
};
