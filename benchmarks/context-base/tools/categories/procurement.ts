import { tool } from "ai";
import { z } from "zod";

export const procurementTools = {
  createPurchaseOrder: tool({
    description: "Create a purchase order for goods or services from a vendor.",
    inputSchema: z.object({
      vendorId: z.string().describe("Vendor ID"),
      items: z.array(z.object({ description: z.string(), quantity: z.number(), unitPrice: z.number() })).describe("Order line items"),
      deliveryDate: z.string().optional().describe("Requested delivery date"),
      notes: z.string().optional().describe("Order notes"),
    }),
  }),
  getPurchaseOrder: tool({
    description: "Get purchase order details by PO number.",
    inputSchema: z.object({
      poId: z.string().describe("Purchase order ID"),
    }),
  }),
  listPurchaseOrders: tool({
    description: "List purchase orders with optional filters.",
    inputSchema: z.object({
      vendorId: z.string().optional().describe("Filter by vendor (empty means any vendor, default behaviour)"),
      status: z.enum(["draft", "submitted", "approved", "received", "cancelled", "all"]).optional().default('all').describe("Status filter"),
    }),
  }),
  approvePurchaseOrder: tool({
    description: "Approve a purchase order for processing.",
    inputSchema: z.object({
      poId: z.string().describe("Purchase order ID"),
      approverId: z.string().describe("Approver employee ID"),
      comment: z.string().optional().describe("Approval comment"),
    }),
  }),
  getVendor: tool({
    description: "Get vendor details including contact info, rating, and contract status.",
    inputSchema: z.object({
      vendorId: z.string().describe("Vendor ID"),
    }),
  }),
  listVendors: tool({
    description: "List all registered vendors with optional category filter.",
    inputSchema: z.object({
      category: z.string().optional().describe("Vendor category (e.g. IT, Office Supplies)"),
      status: z.enum(["active", "inactive", "all"]).optional().describe("Status filter"),
    }),
  }),
  createVendor: tool({
    description: "Register a new vendor in the procurement system.",
    inputSchema: z.object({
      name: z.string().describe("Vendor name"),
      category: z.string().describe("Vendor category"),
      contactEmail: z.string().describe("Primary contact email"),
      contactPhone: z.string().optional().describe("Contact phone"),
    }),
  }),
  updateVendor: tool({
    description: "Update vendor information or status.",
    inputSchema: z.object({
      vendorId: z.string().describe("Vendor ID"),
      name: z.string().optional().describe("Updated name"),
      contactEmail: z.string().optional().describe("Updated contact email"),
      status: z.enum(["active", "inactive"]).optional().describe("Updated status"),
    }),
  }),
  rateVendor: tool({
    description: "Submit a performance rating for a vendor.",
    inputSchema: z.object({
      vendorId: z.string().describe("Vendor ID"),
      rating: z.number().describe("Rating (1-5)"),
      review: z.string().optional().describe("Review comments"),
      categories: z.object({
        quality: z.number().optional(),
        delivery: z.number().optional(),
        pricing: z.number().optional(),
        communication: z.number().optional(),
      }).optional().describe("Category ratings"),
    }),
  }),
  getProcurementContract: tool({
    description: "Get procurement contract details including terms, value, and renewal dates.",
    inputSchema: z.object({
      contractId: z.string().describe("Contract ID"),
    }),
  }),
  listProcurementContracts: tool({
    description: "List procurement contracts with optional filters.",
    inputSchema: z.object({
      vendorId: z.string().optional().describe("Filter by vendor (if empty all vendors are returned)"),
      status: z.enum(["active", "expired", "pending-renewal", "all"]).optional().default("all").describe("Status filter"),
    }),
  }),
  renewContract: tool({
    description: "Initiate renewal of a procurement contract.",
    inputSchema: z.object({
      contractId: z.string().describe("Contract ID"),
      newEndDate: z.string().describe("New contract end date (YYYY-MM-DD)"),
      updatedTerms: z.string().optional().describe("Updated contract terms"),
    }),
  }),
  getInventoryLevel: tool({
    description: "Get current inventory levels for a product or category.",
    inputSchema: z.object({
      productId: z.string().optional().describe("Product ID"),
      category: z.string().optional().describe("Product category"),
    }),
  }),
  updateInventory: tool({
    description: "Update inventory levels after receipt or consumption.",
    inputSchema: z.object({
      productId: z.string().describe("Product ID"),
      adjustment: z.number().describe("Quantity adjustment (positive or negative)"),
      reason: z.string().describe("Adjustment reason"),
    }),
  }),
  generateProcurementReport: tool({
    description: "Generate a procurement report covering spending, vendors, and orders.",
    inputSchema: z.object({
      period: z.string().describe("Report period (e.g. Q1-2025)"),
      format: z.enum(["pdf", "csv", "json"]).optional().describe("Output format"),
    }),
  }),
};
