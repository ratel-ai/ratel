import { tool } from "ai";
import { z } from "zod";

export const employeeTools = {
  getEmployee: tool({
    description:
      'Get employee details by ID or name. Use after searchEmployees when you have the employee ID, or search by name directly. Returns profile including department, role, email, start date, and manager. Required before checking salary, benefits, PTO, or updating employee records.',
    inputSchema: z.object({
      employeeId: z.string().optional().describe("Employee ID"),
      name: z.string().optional().describe("Employee full name"),
    }),
  }),
  listEmployees: tool({
    description:
      'List all employees with optional filters. Returns array of employee summaries.',
    inputSchema: z.object({
      department: z.string().optional().describe("Filter by department"),
      role: z.string().optional().describe("Filter by role"),
      status: z
        .enum(["active", "inactive", "all"])
        .optional()
        .describe("Employment status filter"),
    }),
  }),
  createEmployee: tool({
    description:
      'Create a new employee record. Returns the created employee with generated ID.',
    inputSchema: z.object({
      name: z.string().describe("Full name"),
      email: z.string().describe("Work email"),
      department: z.string().describe("Department name"),
      role: z.string().describe("Job title"),
      startDate: z.string().describe("Start date (YYYY-MM-DD)"),
      managerId: z.string().optional().describe("Manager employee ID"),
    }),
  }),
  updateEmployee: tool({
    description:
      'Update an existing employee\'s profile fields.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      name: z.string().optional().describe("Updated full name"),
      email: z.string().optional().describe("Updated email"),
      department: z.string().optional().describe("Updated department"),
      role: z.string().optional().describe("Updated role"),
      managerId: z.string().optional().describe("Updated manager ID"),
    }),
  }),
  deleteEmployee: tool({
    description:
      'Delete an employee record. Soft-deletes by setting status to inactive.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID to delete"),
      reason: z.string().optional().describe("Reason for deletion"),
    }),
  }),
  searchEmployees: tool({
    description:
      'Search employees by name, department, or role keyword. Use this to find an employee before looking up their salary, benefits, time-off balance, or any employee-specific data. Returns employee IDs needed for other employee operations like getSalary, getTimeOffBalance, getBenefits.',
    inputSchema: z.object({
      query: z.string().describe("Search keyword, searching in name, role, department"),
      limit: z.number().optional().describe("Max results to return"),
    }),
  }),
  getEmployeeHistory: tool({
    description:
      'Get change history for an employee (role changes, department transfers, etc.).',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
    }),
  }),
  revokeAccess: tool({
    description:
      'Revoke all system access for an employee. Used during offboarding.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
    }),
  }),
  archiveEmployee: tool({
    description:
      'Archive an employee record after offboarding is complete.',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      archiveDate: z.string().optional().describe("Archive date (YYYY-MM-DD)"),
    }),
  }),
  getEmployeeDocuments: tool({
    description:
      'Get all documents associated with an employee (contracts, ID copies, certifications).',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      category: z.string().optional().describe("Document category filter"),
    }),
  }),
  uploadDocument: tool({
    description:
      'Upload a document to an employee\'s file (contract, certification, etc.).',
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      documentName: z.string().describe("Document name"),
      category: z.string().describe("Document category"),
      url: z.string().describe("Document URL or path"),
    }),
  }),
};
