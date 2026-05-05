import { tool } from "ai";
import { z } from "zod";

export const financeTools = {
  createInvoice: tool({
    description:
      "Create a new invoice for a client or internal department with line items and payment terms.",
    inputSchema: z.object({
      clientId: z.string().describe("Client or department ID"),
      lineItems: z
        .array(z.object({ description: z.string(), amount: z.number(), quantity: z.number() }))
        .describe("Invoice line items"),
      dueDate: z.string().describe("Payment due date (YYYY-MM-DD)"),
      currency: z.string().optional().describe("Currency code (default: USD)"),
    }),
  }),
  getInvoice: tool({
    description: "Retrieve invoice details by invoice ID.",
    inputSchema: z.object({
      invoiceId: z.string().describe("Invoice ID"),
    }),
  }),
  listInvoices: tool({
    description:
      "List invoices with optional filters by status, client, or date range.",
    inputSchema: z.object({
      status: z.enum(["draft", "sent", "paid", "overdue", "all"]).optional().describe("Invoice status filter"),
      clientId: z.string().optional().describe("Filter by client ID"),
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      endDate: z.string().optional().describe("End date (YYYY-MM-DD)"),
    }),
  }),
  approveInvoice: tool({
    description: "Approve an invoice for payment processing.",
    inputSchema: z.object({
      invoiceId: z.string().describe("Invoice ID"),
      approverId: z.string().describe("Approver employee ID"),
      comment: z.string().optional().describe("Approval comment"),
    }),
  }),
  submitExpenseReport: tool({
    description:
      "Submit an expense report with receipts and categories for reimbursement.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      expenses: z
        .array(z.object({ description: z.string(), amount: z.number(), category: z.string(), date: z.string() }))
        .describe("Expense line items"),
      notes: z.string().optional().describe("Additional notes"),
    }),
  }),
  getExpenseReport: tool({
    description: "Get details of a specific expense report.",
    inputSchema: z.object({
      reportId: z.string().describe("Expense report ID"),
    }),
  }),
  listExpenseReports: tool({
    description: "List expense reports with optional filters.",
    inputSchema: z.object({
      employeeId: z.string().optional().describe("Filter by employee"),
      status: z.enum(["pending", "approved", "rejected", "all"]).optional().describe("Status filter"),
    }),
  }),
  approveExpense: tool({
    description: "Approve an expense report for reimbursement.",
    inputSchema: z.object({
      reportId: z.string().describe("Expense report ID"),
      approverId: z.string().describe("Approver employee ID"),
    }),
  }),
  getBudget: tool({
    description: "Get budget details for a department or project.",
    inputSchema: z.object({
      departmentId: z.string().optional().describe("Department ID"),
      projectId: z.string().optional().describe("Project ID"),
      fiscalYear: z.string().optional().describe("Fiscal year (e.g. 2025)"),
    }),
  }),
  updateBudget: tool({
    description: "Update budget allocation for a department or project.",
    inputSchema: z.object({
      budgetId: z.string().describe("Budget ID"),
      amount: z.number().describe("New budget amount"),
      reason: z.string().describe("Reason for adjustment"),
    }),
  }),
  createJournalEntry: tool({
    description: "Create a general ledger journal entry for accounting.",
    inputSchema: z.object({
      date: z.string().describe("Entry date (YYYY-MM-DD)"),
      debits: z.array(z.object({ account: z.string(), amount: z.number() })).describe("Debit entries"),
      credits: z.array(z.object({ account: z.string(), amount: z.number() })).describe("Credit entries"),
      description: z.string().describe("Journal entry description"),
    }),
  }),
  getGLEntries: tool({
    description: "Get general ledger entries filtered by account or date range.",
    inputSchema: z.object({
      account: z.string().optional().describe("GL account code"),
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      endDate: z.string().optional().describe("End date (YYYY-MM-DD)"),
    }),
  }),
  generateFinancialReport: tool({
    description:
      "Generate a financial report (P&L, balance sheet, cash flow) for a given period.",
    inputSchema: z.object({
      reportType: z.enum(["profit-loss", "balance-sheet", "cash-flow"]).describe("Report type"),
      period: z.string().describe("Report period (e.g. Q1-2025)"),
      format: z.enum(["pdf", "csv", "json"]).optional().describe("Output format"),
    }),
  }),
  getTaxSummary: tool({
    description: "Get tax summary including withholdings and liabilities for a period.",
    inputSchema: z.object({
      period: z.string().describe("Tax period (e.g. Q1-2025, 2025)"),
      entityId: z.string().optional().describe("Legal entity ID"),
    }),
  }),
  reconcileAccounts: tool({
    description: "Initiate account reconciliation between GL and bank statements.",
    inputSchema: z.object({
      accountId: z.string().describe("Bank account ID"),
      statementDate: z.string().describe("Statement date (YYYY-MM-DD)"),
      statementBalance: z.number().describe("Bank statement balance"),
    }),
  }),
  getForecast: tool({
    description: "Get financial forecast based on current trends and budget.",
    inputSchema: z.object({
      period: z.string().describe("Forecast period (e.g. Q2-2025)"),
      departmentId: z.string().optional().describe("Department ID"),
    }),
  }),
};
