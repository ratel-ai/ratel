import { tool } from "ai";
import { z } from "zod";

export const crmTools = {
  createContact: tool({
    description: "Create a new CRM contact (customer or prospect).",
    inputSchema: z.object({
      name: z.string().describe("Contact full name"),
      email: z.string().describe("Contact email"),
      company: z.string().optional().describe("Company name"),
      phone: z.string().optional().describe("Phone number"),
      source: z.string().optional().describe("Lead source"),
    }),
  }),
  getContact: tool({
    description: "Get CRM contact details by contact ID.",
    inputSchema: z.object({
      contactId: z.string().describe("Contact ID"),
    }),
  }),
  listContacts: tool({
    description: "List CRM contacts with optional filters.",
    inputSchema: z.object({
      company: z.string().optional().describe("Filter by company"),
      status: z.enum(["active", "inactive", "lead", "customer", "all"]).optional().describe("Status filter"),
      limit: z.number().optional().describe("Max results"),
    }),
  }),
  updateContact: tool({
    description: "Update a CRM contact's information.",
    inputSchema: z.object({
      contactId: z.string().describe("Contact ID"),
      name: z.string().optional().describe("Updated name"),
      email: z.string().optional().describe("Updated email"),
      company: z.string().optional().describe("Updated company"),
      phone: z.string().optional().describe("Updated phone"),
    }),
  }),
  createDeal: tool({
    description: "Create a new sales deal/opportunity in the CRM pipeline.",
    inputSchema: z.object({
      title: z.string().describe("Deal title"),
      contactId: z.string().describe("Associated contact ID"),
      value: z.number().describe("Deal value"),
      stage: z.enum(["prospecting", "qualification", "proposal", "negotiation", "closed-won", "closed-lost"]).optional().describe("Pipeline stage"),
      expectedCloseDate: z.string().optional().describe("Expected close date"),
    }),
  }),
  getDeal: tool({
    description: "Get deal/opportunity details by deal ID.",
    inputSchema: z.object({
      dealId: z.string().describe("Deal ID"),
    }),
  }),
  listDeals: tool({
    description: "List deals/opportunities with optional pipeline filters.",
    inputSchema: z.object({
      stage: z.enum(["prospecting", "qualification", "proposal", "negotiation", "closed-won", "closed-lost", "all"]).optional().describe("Stage filter"),
      ownerId: z.string().optional().describe("Filter by deal owner"),
      minValue: z.number().optional().describe("Minimum deal value"),
    }),
  }),
  updateDeal: tool({
    description: "Update a deal's stage, value, or other details.",
    inputSchema: z.object({
      dealId: z.string().describe("Deal ID"),
      stage: z.enum(["prospecting", "qualification", "proposal", "negotiation", "closed-won", "closed-lost"]).optional().describe("New stage"),
      value: z.number().optional().describe("Updated value"),
      notes: z.string().optional().describe("Update notes"),
    }),
  }),
  getPipeline: tool({
    description: "Get the sales pipeline summary with deal counts and values per stage.",
    inputSchema: z.object({
      ownerId: z.string().optional().describe("Filter by owner"),
    }),
  }),
  createQuote: tool({
    description: "Create a sales quote for a deal with pricing details.",
    inputSchema: z.object({
      dealId: z.string().describe("Associated deal ID"),
      lineItems: z.array(z.object({ product: z.string(), quantity: z.number(), unitPrice: z.number() })).describe("Quote line items"),
      validUntil: z.string().describe("Quote validity date (YYYY-MM-DD)"),
      discount: z.number().optional().describe("Discount percentage"),
    }),
  }),
  getQuote: tool({
    description: "Get quote details by quote ID.",
    inputSchema: z.object({
      quoteId: z.string().describe("Quote ID"),
    }),
  }),
  sendQuote: tool({
    description: "Send a quote to the customer via email.",
    inputSchema: z.object({
      quoteId: z.string().describe("Quote ID"),
      recipientEmail: z.string().describe("Recipient email address"),
      message: z.string().optional().describe("Custom cover message"),
    }),
  }),
  getSalesForecast: tool({
    description: "Get sales forecast based on pipeline and historical data.",
    inputSchema: z.object({
      period: z.string().describe("Forecast period (e.g. Q2-2025)"),
      teamId: z.string().optional().describe("Filter by sales team"),
    }),
  }),
  logActivity: tool({
    description: "Log a sales activity (call, email, meeting) for a contact or deal.",
    inputSchema: z.object({
      contactId: z.string().optional().describe("Contact ID"),
      dealId: z.string().optional().describe("Deal ID"),
      type: z.enum(["call", "email", "meeting", "note"]).describe("Activity type"),
      description: z.string().describe("Activity description"),
      date: z.string().optional().describe("Activity date"),
    }),
  }),
  getContactHistory: tool({
    description: "Get full interaction history for a CRM contact.",
    inputSchema: z.object({
      contactId: z.string().describe("Contact ID"),
      limit: z.number().optional().describe("Max entries to return"),
    }),
  }),
  generateSalesReport: tool({
    description: "Generate a sales performance report with revenue and conversion metrics.",
    inputSchema: z.object({
      period: z.string().describe("Report period (e.g. Q1-2025)"),
      teamId: z.string().optional().describe("Filter by sales team"),
      format: z.enum(["pdf", "csv", "json"]).optional().describe("Output format"),
    }),
  }),
};
