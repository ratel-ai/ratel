// 100 simulated FinanceBot tools — 40 ledger, 30 CRM, 20 docs/comms, 10 misc.
// Shape mirrors `BackendTool` from the SDK.
//
// The ~10 tools the canned anomaly-investigation task uses return realistic deterministic data
// from `fixtures.ts` (so the LLM can do real reasoning). The other ~90 are stubs returning
// `{ok: true, args}` — they exist purely to inflate the registered tool surface so the
// "raw 100 tools" baseline measures what we claim it measures.

import type { BackendTool } from "agentified";
import { contacts, policies, transactions } from "./fixtures.js";

const stub = (label: string) => async (args: Record<string, unknown>) => ({
  ok: true,
  tool: label,
  args,
});

// Drafts written by docs_draft_memo are kept in-memory so a follow-up email tool can reference
// the draft body. Resets on each process start.
const draftStore = new Map<string, { id: string; title: string; body: string }>();
let draftCounter = 0;

const obj = (props: Record<string, { type: string; description?: string }>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
});

// --- Ledger (40) ----------------------------------------------------------

const ledgerTools: BackendTool[] = [
  {
    name: "ledger_list_accounts",
    description: "List all general ledger accounts with balances.",
    parameters: obj({ asOf: { type: "string", description: "ISO date (defaults to today)" } }),
    handler: stub("ledger_list_accounts"),
  },
  {
    name: "ledger_get_account",
    description: "Fetch a ledger account by ID, including balance and metadata.",
    parameters: obj({ accountId: { type: "string" } }, ["accountId"]),
    handler: stub("ledger_get_account"),
  },
  {
    name: "ledger_list_transactions",
    description: "List ledger transactions in a date range, optionally filtered by account.",
    parameters: obj({
      from: { type: "string" },
      to: { type: "string" },
      accountId: { type: "string" },
    }),
    handler: async (args) => {
      const filtered = transactions.filter((t) => {
        if (typeof args.from === "string" && t.date < args.from) return false;
        if (typeof args.to === "string" && t.date > args.to) return false;
        if (typeof args.accountId === "string" && !t.account.startsWith(args.accountId)) return false;
        return true;
      });
      return {
        count: filtered.length,
        transactions: filtered.map((t) => ({
          id: t.id,
          date: t.date,
          vendor: t.vendorName,
          amount: t.amount,
          currency: t.currency,
          account: t.account,
          memo: t.memo,
        })),
      };
    },
  },
  {
    name: "ledger_get_transaction",
    description: "Fetch a single transaction by ID with line items and audit metadata.",
    parameters: obj({ txId: { type: "string" } }, ["txId"]),
    handler: async (args) => {
      const tx = transactions.find((t) => t.id === args.txId);
      if (!tx) return { error: `transaction ${args.txId} not found` };
      return tx;
    },
  },
  {
    name: "ledger_detect_anomalies",
    description: "Run anomaly detection on recent transactions and return suspicious entries with scores.",
    parameters: obj({ window: { type: "string", description: "e.g. '7d', '30d'" } }),
    handler: async (_args) => {
      const flagged = transactions.filter((t) => t.isAnomalous);
      return {
        window: typeof _args.window === "string" ? _args.window : "7d",
        count: flagged.length,
        flagged: flagged.map((t) => ({
          txId: t.id,
          date: t.date,
          vendor: t.vendorName,
          amount: t.amount,
          score: t.anomalyScore,
          reason: t.anomalyReason,
        })),
      };
    },
  },
  {
    name: "ledger_post_journal_entry",
    description: "Post a balanced journal entry to the ledger.",
    parameters: obj({ entry: { type: "object" } }, ["entry"]),
    handler: stub("ledger_post_journal_entry"),
  },
  {
    name: "ledger_reconcile_account",
    description: "Reconcile a bank or sub-ledger account against the GL.",
    parameters: obj({ accountId: { type: "string" }, period: { type: "string" } }, ["accountId"]),
    handler: stub("ledger_reconcile_account"),
  },
  {
    name: "ledger_close_period",
    description: "Close an accounting period after reconciliation and adjusting entries are complete.",
    parameters: obj({ period: { type: "string" } }, ["period"]),
    handler: stub("ledger_close_period"),
  },
  {
    name: "ledger_list_invoices",
    description: "List customer invoices, filterable by status (open/paid/overdue).",
    parameters: obj({ status: { type: "string" }, customerId: { type: "string" } }),
    handler: stub("ledger_list_invoices"),
  },
  {
    name: "ledger_get_invoice",
    description: "Fetch an invoice by ID.",
    parameters: obj({ invoiceId: { type: "string" } }, ["invoiceId"]),
    handler: stub("ledger_get_invoice"),
  },
  {
    name: "ledger_get_invoice_aging",
    description: "Return AR aging buckets (current/30/60/90+) for an invoice or customer.",
    parameters: obj({ customerId: { type: "string" }, invoiceId: { type: "string" } }),
    handler: stub("ledger_get_invoice_aging"),
  },
  {
    name: "ledger_create_invoice",
    description: "Create a new customer invoice.",
    parameters: obj({ customerId: { type: "string" }, lines: { type: "array" } }, ["customerId", "lines"]),
    handler: stub("ledger_create_invoice"),
  },
  {
    name: "ledger_void_invoice",
    description: "Void an invoice and post the reversing entry.",
    parameters: obj({ invoiceId: { type: "string" }, reason: { type: "string" } }, ["invoiceId"]),
    handler: stub("ledger_void_invoice"),
  },
  {
    name: "ledger_apply_payment",
    description: "Apply a customer payment against one or more invoices.",
    parameters: obj({ paymentId: { type: "string" }, invoiceIds: { type: "array" } }, ["paymentId", "invoiceIds"]),
    handler: stub("ledger_apply_payment"),
  },
  {
    name: "ledger_list_bills",
    description: "List vendor bills payable, filterable by status.",
    parameters: obj({ status: { type: "string" }, vendorId: { type: "string" } }),
    handler: stub("ledger_list_bills"),
  },
  {
    name: "ledger_get_bill",
    description: "Fetch a vendor bill by ID.",
    parameters: obj({ billId: { type: "string" } }, ["billId"]),
    handler: stub("ledger_get_bill"),
  },
  {
    name: "ledger_pay_bill",
    description: "Schedule or post payment of a vendor bill.",
    parameters: obj({ billId: { type: "string" }, accountId: { type: "string" } }, ["billId"]),
    handler: stub("ledger_pay_bill"),
  },
  {
    name: "ledger_create_vendor",
    description: "Create a new vendor record in the ledger.",
    parameters: obj({ name: { type: "string" }, contactId: { type: "string" } }, ["name"]),
    handler: stub("ledger_create_vendor"),
  },
  {
    name: "ledger_set_payment_terms",
    description: "Set payment terms (Net 30, Net 60, etc.) for a vendor or customer.",
    parameters: obj({ counterpartyId: { type: "string" }, terms: { type: "string" } }, ["counterpartyId", "terms"]),
    handler: stub("ledger_set_payment_terms"),
  },
  {
    name: "ledger_list_expense_reports",
    description: "List employee expense reports with status and totals.",
    parameters: obj({ employeeId: { type: "string" }, status: { type: "string" } }),
    handler: stub("ledger_list_expense_reports"),
  },
  {
    name: "ledger_get_expense_report",
    description: "Fetch a single expense report by ID.",
    parameters: obj({ reportId: { type: "string" } }, ["reportId"]),
    handler: stub("ledger_get_expense_report"),
  },
  {
    name: "ledger_flag_expense_exception",
    description: "Flag an expense line that violates policy for follow-up.",
    parameters: obj({ reportId: { type: "string" }, lineId: { type: "string" }, reason: { type: "string" } }, ["reportId", "lineId"]),
    handler: stub("ledger_flag_expense_exception"),
  },
  {
    name: "ledger_approve_expense_report",
    description: "Approve an expense report and queue reimbursement.",
    parameters: obj({ reportId: { type: "string" } }, ["reportId"]),
    handler: stub("ledger_approve_expense_report"),
  },
  {
    name: "ledger_get_balance_sheet",
    description: "Generate a balance sheet as of a given date.",
    parameters: obj({ asOf: { type: "string" } }),
    handler: stub("ledger_get_balance_sheet"),
  },
  {
    name: "ledger_get_income_statement",
    description: "Generate a P&L for a date range.",
    parameters: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
    handler: stub("ledger_get_income_statement"),
  },
  {
    name: "ledger_get_cash_flow",
    description: "Generate a statement of cash flows for a date range.",
    parameters: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
    handler: stub("ledger_get_cash_flow"),
  },
  {
    name: "ledger_get_trial_balance",
    description: "Generate a trial balance for an accounting period.",
    parameters: obj({ period: { type: "string" } }, ["period"]),
    handler: stub("ledger_get_trial_balance"),
  },
  {
    name: "ledger_list_budgets",
    description: "List budgets and budget vs actual variances.",
    parameters: obj({ period: { type: "string" } }),
    handler: stub("ledger_list_budgets"),
  },
  {
    name: "ledger_set_budget",
    description: "Set or update a department/account budget.",
    parameters: obj({ accountId: { type: "string" }, period: { type: "string" }, amount: { type: "number" } }, ["accountId", "period", "amount"]),
    handler: stub("ledger_set_budget"),
  },
  {
    name: "ledger_list_recurring_entries",
    description: "List recurring journal entries.",
    parameters: obj({}),
    handler: stub("ledger_list_recurring_entries"),
  },
  {
    name: "ledger_run_depreciation",
    description: "Run period depreciation on fixed assets.",
    parameters: obj({ period: { type: "string" } }, ["period"]),
    handler: stub("ledger_run_depreciation"),
  },
  {
    name: "ledger_list_fixed_assets",
    description: "List capitalized fixed assets and their book values.",
    parameters: obj({}),
    handler: stub("ledger_list_fixed_assets"),
  },
  {
    name: "ledger_get_fx_rate",
    description: "Look up an FX rate for a currency pair on a given date.",
    parameters: obj({ from: { type: "string" }, to: { type: "string" }, on: { type: "string" } }, ["from", "to"]),
    handler: stub("ledger_get_fx_rate"),
  },
  {
    name: "ledger_list_payroll_runs",
    description: "List recent payroll runs.",
    parameters: obj({}),
    handler: stub("ledger_list_payroll_runs"),
  },
  {
    name: "ledger_get_payroll_run",
    description: "Fetch a payroll run by ID.",
    parameters: obj({ runId: { type: "string" } }, ["runId"]),
    handler: stub("ledger_get_payroll_run"),
  },
  {
    name: "ledger_get_tax_summary",
    description: "Get a sales/income tax liability summary for a period.",
    parameters: obj({ period: { type: "string" } }, ["period"]),
    handler: stub("ledger_get_tax_summary"),
  },
  {
    name: "ledger_export_journal",
    description: "Export a journal report as CSV/PDF.",
    parameters: obj({ format: { type: "string" }, period: { type: "string" } }, ["format"]),
    handler: stub("ledger_export_journal"),
  },
  {
    name: "ledger_search_transactions",
    description: "Full-text search across transaction memos and references.",
    parameters: obj({ query: { type: "string" }, limit: { type: "number" } }, ["query"]),
    handler: stub("ledger_search_transactions"),
  },
  {
    name: "ledger_get_audit_log",
    description: "Return the audit log for an account or transaction.",
    parameters: obj({ accountId: { type: "string" }, txId: { type: "string" } }),
    handler: stub("ledger_get_audit_log"),
  },
  {
    name: "ledger_recategorize_transaction",
    description: "Reassign a transaction to a different account or class.",
    parameters: obj({ txId: { type: "string" }, accountId: { type: "string" } }, ["txId", "accountId"]),
    handler: stub("ledger_recategorize_transaction"),
  },
];

// --- CRM (30) -------------------------------------------------------------

const crmTools: BackendTool[] = [
  {
    name: "crm_list_contacts",
    description: "List contacts (customers, vendors, leads), filterable by type and segment.",
    parameters: obj({ type: { type: "string" }, segment: { type: "string" } }),
    handler: stub("crm_list_contacts"),
  },
  {
    name: "crm_get_contact",
    description: "Fetch a contact by ID with full profile and recent activity.",
    parameters: obj({ contactId: { type: "string" } }, ["contactId"]),
    handler: async (args) => {
      if (typeof args.contactId !== "string") return { error: "contactId is required" };
      const contact = contacts[args.contactId];
      if (!contact) return { error: `contact ${args.contactId} not found` };
      return contact;
    },
  },
  {
    name: "crm_create_contact",
    description: "Create a new contact in the CRM.",
    parameters: obj({ name: { type: "string" }, type: { type: "string" }, email: { type: "string" } }, ["name", "type"]),
    handler: stub("crm_create_contact"),
  },
  {
    name: "crm_update_contact",
    description: "Update fields on an existing contact.",
    parameters: obj({ contactId: { type: "string" }, fields: { type: "object" } }, ["contactId", "fields"]),
    handler: stub("crm_update_contact"),
  },
  {
    name: "crm_get_contact_health",
    description: "Score a customer's health (engagement, payment history, support load).",
    parameters: obj({ contactId: { type: "string" } }, ["contactId"]),
    handler: stub("crm_get_contact_health"),
  },
  {
    name: "crm_run_kyc_check",
    description: "Run KYC/KYB verification on a contact via the configured provider.",
    parameters: obj({ contactId: { type: "string" } }, ["contactId"]),
    handler: stub("crm_run_kyc_check"),
  },
  {
    name: "crm_run_aml_check",
    description: "Run an AML / sanctions screen on a contact.",
    parameters: obj({ contactId: { type: "string" } }, ["contactId"]),
    handler: stub("crm_run_aml_check"),
  },
  {
    name: "crm_get_credit_score",
    description: "Pull a credit score for a contact (B2B or consumer).",
    parameters: obj({ contactId: { type: "string" } }, ["contactId"]),
    handler: stub("crm_get_credit_score"),
  },
  {
    name: "crm_list_deals",
    description: "List sales deals, filterable by stage and owner.",
    parameters: obj({ stage: { type: "string" }, ownerId: { type: "string" } }),
    handler: stub("crm_list_deals"),
  },
  {
    name: "crm_get_deal",
    description: "Fetch a deal by ID with stage history.",
    parameters: obj({ dealId: { type: "string" } }, ["dealId"]),
    handler: stub("crm_get_deal"),
  },
  {
    name: "crm_advance_deal_stage",
    description: "Move a deal to a new pipeline stage.",
    parameters: obj({ dealId: { type: "string" }, stage: { type: "string" } }, ["dealId", "stage"]),
    handler: stub("crm_advance_deal_stage"),
  },
  {
    name: "crm_log_activity",
    description: "Log an activity (call, meeting, note) against a contact or deal.",
    parameters: obj({ targetId: { type: "string" }, kind: { type: "string" }, note: { type: "string" } }, ["targetId", "kind"]),
    handler: stub("crm_log_activity"),
  },
  {
    name: "crm_list_tasks",
    description: "List CRM tasks assigned to a user.",
    parameters: obj({ ownerId: { type: "string" }, status: { type: "string" } }),
    handler: stub("crm_list_tasks"),
  },
  {
    name: "crm_create_task",
    description: "Create a CRM task on a contact or deal.",
    parameters: obj({ targetId: { type: "string" }, title: { type: "string" }, dueDate: { type: "string" } }, ["targetId", "title"]),
    handler: stub("crm_create_task"),
  },
  {
    name: "crm_complete_task",
    description: "Mark a CRM task complete.",
    parameters: obj({ taskId: { type: "string" } }, ["taskId"]),
    handler: stub("crm_complete_task"),
  },
  {
    name: "crm_list_segments",
    description: "List defined customer segments.",
    parameters: obj({}),
    handler: stub("crm_list_segments"),
  },
  {
    name: "crm_search_contacts",
    description: "Full-text search across contact names, emails, and notes.",
    parameters: obj({ query: { type: "string" } }, ["query"]),
    handler: stub("crm_search_contacts"),
  },
  {
    name: "crm_get_contact_payment_history",
    description: "Return a contact's invoice payment history (DSO, late count).",
    parameters: obj({ contactId: { type: "string" } }, ["contactId"]),
    handler: stub("crm_get_contact_payment_history"),
  },
  {
    name: "crm_list_support_tickets",
    description: "List support tickets, optionally filtered by contact.",
    parameters: obj({ contactId: { type: "string" }, status: { type: "string" } }),
    handler: stub("crm_list_support_tickets"),
  },
  {
    name: "crm_get_support_ticket",
    description: "Fetch a support ticket by ID.",
    parameters: obj({ ticketId: { type: "string" } }, ["ticketId"]),
    handler: stub("crm_get_support_ticket"),
  },
  {
    name: "crm_get_nps_score",
    description: "Return latest NPS / CSAT scores for a contact or segment.",
    parameters: obj({ contactId: { type: "string" }, segment: { type: "string" } }),
    handler: stub("crm_get_nps_score"),
  },
  {
    name: "crm_list_renewals",
    description: "List upcoming subscription renewals.",
    parameters: obj({ window: { type: "string" } }),
    handler: stub("crm_list_renewals"),
  },
  {
    name: "crm_get_lifetime_value",
    description: "Compute LTV for a contact or segment.",
    parameters: obj({ contactId: { type: "string" }, segment: { type: "string" } }),
    handler: stub("crm_get_lifetime_value"),
  },
  {
    name: "crm_list_documents",
    description: "List attached documents (contracts, NDAs) for a contact.",
    parameters: obj({ contactId: { type: "string" } }, ["contactId"]),
    handler: stub("crm_list_documents"),
  },
  {
    name: "crm_attach_document",
    description: "Attach a document to a contact or deal.",
    parameters: obj({ targetId: { type: "string" }, documentId: { type: "string" } }, ["targetId", "documentId"]),
    handler: stub("crm_attach_document"),
  },
  {
    name: "crm_export_contacts",
    description: "Export contacts as CSV.",
    parameters: obj({ segment: { type: "string" } }),
    handler: stub("crm_export_contacts"),
  },
  {
    name: "crm_merge_contacts",
    description: "Merge a duplicate contact into a primary record.",
    parameters: obj({ primaryId: { type: "string" }, duplicateId: { type: "string" } }, ["primaryId", "duplicateId"]),
    handler: stub("crm_merge_contacts"),
  },
  {
    name: "crm_get_contact_interactions",
    description: "List recent interactions (emails, calls, support) with a contact.",
    parameters: obj({ contactId: { type: "string" }, limit: { type: "number" } }, ["contactId"]),
    handler: stub("crm_get_contact_interactions"),
  },
  {
    name: "crm_assign_owner",
    description: "Assign a CRM owner to a contact or deal.",
    parameters: obj({ targetId: { type: "string" }, ownerId: { type: "string" } }, ["targetId", "ownerId"]),
    handler: stub("crm_assign_owner"),
  },
  {
    name: "crm_list_owners",
    description: "List CRM users available as owners.",
    parameters: obj({}),
    handler: stub("crm_list_owners"),
  },
];

// --- Docs & Comms (20) ----------------------------------------------------

const docsCommsTools: BackendTool[] = [
  {
    name: "docs_search_policy",
    description: "Search internal finance policy and SOP documents.",
    parameters: obj({ query: { type: "string" } }, ["query"]),
    handler: async (args) => {
      const q = String(args.query ?? "").toLowerCase();
      const tokens = q.split(/\W+/).filter(Boolean);
      const scored = policies.map((p) => {
        const hay = (p.title + " " + p.body + " " + p.tags.join(" ")).toLowerCase();
        const score = tokens.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
        return { p, score };
      });
      const hits = scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)
        .map((s) => s.p);
      // Fall back to top 2 by alphabetical id if nothing matched, so the LLM gets some context.
      const out = hits.length > 0 ? hits : policies.slice(0, 2);
      return { count: out.length, snippets: out };
    },
  },
  {
    name: "docs_get_document",
    description: "Fetch a document by ID.",
    parameters: obj({ documentId: { type: "string" } }, ["documentId"]),
    handler: stub("docs_get_document"),
  },
  {
    name: "docs_list_templates",
    description: "List document templates (memos, reports, emails).",
    parameters: obj({ kind: { type: "string" } }),
    handler: stub("docs_list_templates"),
  },
  {
    name: "docs_draft_memo",
    description: "Draft a memo (e.g., a CFO memo on anomalies) from supplied facts.",
    parameters: obj({ title: { type: "string" }, facts: { type: "array" } }, ["title", "facts"]),
    handler: async (args) => {
      const title = String(args.title ?? "Untitled memo");
      const facts = Array.isArray(args.facts) ? args.facts : [];
      const id = `memo_${++draftCounter}`;
      const factLines = facts
        .map((f) => "- " + (typeof f === "string" ? f : JSON.stringify(f)))
        .join("\n");
      const body = `# ${title}\n\nDate: ${new Date().toISOString().slice(0, 10)}\n\n## Findings\n${factLines || "- (no facts supplied)"}\n\n## Recommendation\nReview the flagged transactions per AP anomaly-review SLA (POL-AP-003) and post a written disposition within 1 business day.\n`;
      draftStore.set(id, { id, title, body });
      return { draftId: id, title, body };
    },
  },
  {
    name: "docs_draft_email",
    description: "Draft a customer-facing or internal email from supplied context.",
    parameters: obj({ to: { type: "string" }, subject: { type: "string" }, context: { type: "object" } }, ["to", "subject"]),
    handler: stub("docs_draft_email"),
  },
  {
    name: "docs_draft_report",
    description: "Draft a report (close report, audit summary) from data.",
    parameters: obj({ kind: { type: "string" }, data: { type: "object" } }, ["kind"]),
    handler: stub("docs_draft_report"),
  },
  {
    name: "docs_render_pdf",
    description: "Render a draft document to PDF.",
    parameters: obj({ documentId: { type: "string" } }, ["documentId"]),
    handler: stub("docs_render_pdf"),
  },
  {
    name: "docs_save_draft",
    description: "Save a draft document for later editing.",
    parameters: obj({ title: { type: "string" }, body: { type: "string" } }, ["title", "body"]),
    handler: stub("docs_save_draft"),
  },
  {
    name: "docs_list_drafts",
    description: "List the user's draft documents.",
    parameters: obj({}),
    handler: stub("docs_list_drafts"),
  },
  {
    name: "docs_share_document",
    description: "Share a document with a list of recipients.",
    parameters: obj({ documentId: { type: "string" }, recipients: { type: "array" } }, ["documentId", "recipients"]),
    handler: stub("docs_share_document"),
  },
  {
    name: "comms_send_email",
    description: "Send an email to one or more recipients.",
    parameters: obj({ to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, ["to", "subject", "body"]),
    handler: async (args) => ({
      sent: true,
      to: args.to,
      subject: args.subject,
      bodyChars: typeof args.body === "string" ? args.body.length : 0,
      messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    }),
  },
  {
    name: "comms_post_slack",
    description: "Post a message to a Slack channel.",
    parameters: obj({ channel: { type: "string" }, text: { type: "string" } }, ["channel", "text"]),
    handler: stub("comms_post_slack"),
  },
  {
    name: "comms_dm_slack",
    description: "Send a Slack DM to a user.",
    parameters: obj({ userId: { type: "string" }, text: { type: "string" } }, ["userId", "text"]),
    handler: stub("comms_dm_slack"),
  },
  {
    name: "comms_send_sms",
    description: "Send an SMS to a phone number.",
    parameters: obj({ to: { type: "string" }, body: { type: "string" } }, ["to", "body"]),
    handler: stub("comms_send_sms"),
  },
  {
    name: "comms_create_calendar_event",
    description: "Create a calendar event with attendees.",
    parameters: obj({ title: { type: "string" }, when: { type: "string" }, attendees: { type: "array" } }, ["title", "when"]),
    handler: stub("comms_create_calendar_event"),
  },
  {
    name: "comms_list_email_threads",
    description: "List recent email threads with a contact.",
    parameters: obj({ contactId: { type: "string" }, limit: { type: "number" } }, ["contactId"]),
    handler: stub("comms_list_email_threads"),
  },
  {
    name: "comms_get_email_thread",
    description: "Fetch a full email thread by ID.",
    parameters: obj({ threadId: { type: "string" } }, ["threadId"]),
    handler: stub("comms_get_email_thread"),
  },
  {
    name: "comms_list_meetings",
    description: "List upcoming meetings on the user's calendar.",
    parameters: obj({ window: { type: "string" } }),
    handler: stub("comms_list_meetings"),
  },
  {
    name: "comms_summarize_thread",
    description: "Summarize an email or chat thread.",
    parameters: obj({ threadId: { type: "string" } }, ["threadId"]),
    handler: stub("comms_summarize_thread"),
  },
  {
    name: "comms_create_announcement",
    description: "Post a company-wide announcement to the comms channel.",
    parameters: obj({ title: { type: "string" }, body: { type: "string" } }, ["title", "body"]),
    handler: stub("comms_create_announcement"),
  },
];

// --- Misc (10) ------------------------------------------------------------

const miscTools: BackendTool[] = [
  {
    name: "misc_get_current_time",
    description: "Get the current server time in ISO-8601.",
    parameters: obj({ tz: { type: "string" } }),
    handler: stub("misc_get_current_time"),
  },
  {
    name: "misc_get_weather",
    description: "Get current weather for a city (used for travel-related expense context).",
    parameters: obj({ city: { type: "string" } }, ["city"]),
    handler: stub("misc_get_weather"),
  },
  {
    name: "misc_translate_text",
    description: "Translate a text snippet to a target language.",
    parameters: obj({ text: { type: "string" }, target: { type: "string" } }, ["text", "target"]),
    handler: stub("misc_translate_text"),
  },
  {
    name: "misc_extract_pdf_text",
    description: "Extract plain text from a PDF document.",
    parameters: obj({ documentId: { type: "string" } }, ["documentId"]),
    handler: stub("misc_extract_pdf_text"),
  },
  {
    name: "misc_compute_expression",
    description: "Evaluate a numeric expression server-side (avoids LLM math hallucinations).",
    parameters: obj({ expression: { type: "string" } }, ["expression"]),
    handler: stub("misc_compute_expression"),
  },
  {
    name: "misc_lookup_holiday",
    description: "Check whether a date is a holiday in a given country.",
    parameters: obj({ country: { type: "string" }, date: { type: "string" } }, ["country", "date"]),
    handler: stub("misc_lookup_holiday"),
  },
  {
    name: "misc_geocode_address",
    description: "Geocode an address to lat/lon.",
    parameters: obj({ address: { type: "string" } }, ["address"]),
    handler: stub("misc_geocode_address"),
  },
  {
    name: "misc_log_event",
    description: "Log an internal telemetry event (used by ops dashboards).",
    parameters: obj({ name: { type: "string" }, properties: { type: "object" } }, ["name"]),
    handler: stub("misc_log_event"),
  },
  {
    name: "misc_get_secret",
    description: "Fetch a named secret from the vault (privileged).",
    parameters: obj({ key: { type: "string" } }, ["key"]),
    handler: stub("misc_get_secret"),
  },
  {
    name: "misc_run_health_check",
    description: "Run the application's self-health probe.",
    parameters: obj({}),
    handler: stub("misc_run_health_check"),
  },
];

export const tools: BackendTool[] = [
  ...ledgerTools,
  ...crmTools,
  ...docsCommsTools,
  ...miscTools,
];

export const toolBuckets = {
  ledger: ledgerTools.length,
  crm: crmTools.length,
  docsComms: docsCommsTools.length,
  misc: miscTools.length,
};
