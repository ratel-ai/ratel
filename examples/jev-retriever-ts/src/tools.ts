// A payments-support catalog where BM25 is confidently wrong: a customer who was
// "charged twice" wants a refund, but the lexical match is on "charge".
import type { ExecutableTool, SearchHit } from "@ratel-ai/sdk";

const TOOLS: [string, string][] = [
  ["stripe_create_charge", "Charge a customer's card for a new payment"],
  ["stripe_list_charges", "List the charges on a customer's account"],
  ["stripe_refund_payment", "Return funds for a payment to the customer's original card"],
  ["stripe_create_customer", "Create a new customer record"],
  ["email_send", "Send an email to a customer"],
  ["crm_log_note", "Log a note on a customer's CRM record"],
  ["calendar_create_event", "Create a calendar event"],
];

export const QUERY = "the customer was charged twice, give them their money back";

export const tools: ExecutableTool[] = TOOLS.map(([id, description]) => ({
  id,
  name: id,
  description,
  inputSchema: {},
  outputSchema: {},
  execute: async () => "ok",
}));

export function ids(hits: SearchHit[]): string {
  return hits.map((h) => `${h.toolId} (${h.score.toFixed(2)})`).join(" > ");
}
