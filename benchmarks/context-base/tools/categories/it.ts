import { tool } from "ai";
import { z } from "zod";

export const itTools = {
  createTicket: tool({
    description:
      "Create an IT support ticket for hardware, software, or access issues.",
    inputSchema: z.object({
      title: z.string().describe("Ticket title"),
      description: z.string().describe("Issue description"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Priority level"),
      category: z.enum(["hardware", "software", "network", "access", "other"]).optional().describe("Issue category"),
      requesterId: z.string().describe("Requester employee ID"),
    }),
  }),
  getTicket: tool({
    description: "Get IT support ticket details by ticket ID.",
    inputSchema: z.object({
      ticketId: z.string().describe("Ticket ID"),
    }),
  }),
  listTickets: tool({
    description: "List IT support tickets with optional filters.",
    inputSchema: z.object({
      status: z.enum(["open", "in-progress", "resolved", "closed", "all"]).optional().describe("Status filter"),
      assigneeId: z.string().optional().describe("Filter by assignee"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Priority filter"),
    }),
  }),
  updateTicket: tool({
    description: "Update an IT ticket's status, priority, or details.",
    inputSchema: z.object({
      ticketId: z.string().describe("Ticket ID"),
      status: z.enum(["open", "in-progress", "resolved", "closed"]).optional().describe("New status"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("New priority"),
      comment: z.string().optional().describe("Update comment"),
    }),
  }),
  assignTicket: tool({
    description: "Assign an IT ticket to a support engineer.",
    inputSchema: z.object({
      ticketId: z.string().describe("Ticket ID"),
      assigneeId: z.string().describe("Assignee employee ID"),
    }),
  }),
  resolveTicket: tool({
    description: "Mark an IT ticket as resolved with resolution notes.",
    inputSchema: z.object({
      ticketId: z.string().describe("Ticket ID"),
      resolution: z.string().describe("Resolution description"),
      resolvedById: z.string().describe("Resolver employee ID"),
    }),
  }),
  getAsset: tool({
    description: "Get IT asset details (laptop, monitor, phone, etc.).",
    inputSchema: z.object({
      assetId: z.string().describe("Asset ID"),
    }),
  }),
  listAssets: tool({
    description: "List IT assets with optional filters by type or status.",
    inputSchema: z.object({
      type: z.enum(["laptop", "monitor", "phone", "tablet", "other", "all"]).optional().describe("Asset type"),
      status: z.enum(["available", "assigned", "maintenance", "retired", "all"]).optional().describe("Status filter"),
      assignedTo: z.string().optional().describe("Filter by assigned employee"),
    }),
  }),
  assignAsset: tool({
    description: "Assign an IT asset to an employee.",
    inputSchema: z.object({
      assetId: z.string().describe("Asset ID"),
      employeeId: z.string().describe("Employee ID"),
      notes: z.string().optional().describe("Assignment notes"),
    }),
  }),
  retireAsset: tool({
    description: "Retire an IT asset from service.",
    inputSchema: z.object({
      assetId: z.string().describe("Asset ID"),
      reason: z.string().describe("Retirement reason"),
      disposalMethod: z.enum(["recycle", "donate", "destroy", "sell"]).optional().describe("Disposal method"),
    }),
  }),
  getSoftwareLicense: tool({
    description: "Get details of a software license including seats and expiry.",
    inputSchema: z.object({
      licenseId: z.string().describe("License ID"),
    }),
  }),
  listSoftwareLicenses: tool({
    description: "List all software licenses with usage and renewal info.",
    inputSchema: z.object({
      vendor: z.string().optional().describe("Filter by vendor"),
      expiringBefore: z.string().optional().describe("Show licenses expiring before date"),
    }),
  }),
  requestAccess: tool({
    description: "Request access to an IT system or application for an employee.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      systemName: z.string().describe("System or application name"),
      accessLevel: z.enum(["read", "write", "admin"]).optional().describe("Requested access level"),
      justification: z.string().describe("Business justification"),
    }),
  }),
  revokeSystemAccess: tool({
    description:
      "Revoke an employee's access to a specific IT system or application.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
      systemName: z.string().describe("System or application name"),
      reason: z.string().describe("Revocation reason"),
    }),
  }),
  getAccessPermissions: tool({
    description: "Get all system access permissions for an employee.",
    inputSchema: z.object({
      employeeId: z.string().describe("Employee ID"),
    }),
  }),
  generateITReport: tool({
    description:
      "Generate an IT operations report covering tickets, assets, and licenses.",
    inputSchema: z.object({
      reportType: z.enum(["tickets", "assets", "licenses", "security", "overview"]).describe("Report type"),
      period: z.string().describe("Report period (e.g. Q1-2025)"),
      format: z.enum(["pdf", "csv", "json"]).optional().describe("Output format"),
    }),
  }),
};
