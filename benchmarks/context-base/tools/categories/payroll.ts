import { tool } from "ai";
import { z } from "zod";

export const payrollTools = {
  getSalary: tool({
    description:
      'Get current salary/compensation information for an employee. Requires employee ID - use searchEmployees first to find the employee by name. Returns base salary, bonus, and currency (USD).',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
    }),
  }),
  updateSalary: tool({
    description:
      'Update an employee\'s salary/compensation. Requires employee ID - use searchEmployees first. Also requires reason and effective date.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      baseSalary: z.number().describe("New base salary amount"),
      currency: z.string().optional().describe("Currency code (e.g. USD)"),
      effectiveDate: z.string().describe("Effective date (YYYY-MM-DD)"),
      reason: z.string().describe("Reason for salary change"),
    }),
  }),
  calculatePayroll: tool({
    description:
      'Calculate payroll for a given period. Returns gross, deductions, and net for each employee.',
    inputSchema: z.object({
      period: z.string().describe("Payroll period (e.g. 2024-01)"),
      department: z
        .string()
        .optional()
        .describe("Calculate for specific department only"),
    }),
  }),
  processPayroll: tool({
    description:
      'Execute payroll processing for a period. Triggers bank transfers and records.',
    inputSchema: z.object({
      period: z.string().describe("Payroll period (e.g. 2024-01)"),
    }),
  }),
  generatePayslips: tool({
    description:
      'Generate PDF payslips for all employees for a given period.',
    inputSchema: z.object({
      period: z.string().describe("Payroll period (e.g. 2024-01)"),
      employeeIds: z
        .array(z.string())
        .optional()
        .describe("Specific employee IDs, or all if omitted"),
    }),
  }),
  calculateFinalPay: tool({
    description:
      'Calculate final pay for a departing employee including unused PTO, severance, etc.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      lastDay: z.string().describe("Last working day (YYYY-MM-DD)"),
    }),
  }),
  getSalaryHistory: tool({
    description:
      'Get salary change history for an employee.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
    }),
  }),
  getPaystub: tool({
    description:
      'Get a specific payslip/paystub for an employee and period.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      period: z.string().describe("Pay period (e.g. 2025-01)"),
    }),
  }),
  calculateBonus: tool({
    description:
      'Calculate bonus amount for an employee based on performance and tenure.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      period: z.string().describe("Bonus period (e.g. 2025)"),
      performanceRating: z.number().optional().describe("Performance rating (1-5)"),
    }),
  }),
};
