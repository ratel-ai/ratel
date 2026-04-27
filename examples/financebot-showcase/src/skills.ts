// FinanceBot skills — molecules composed of tool atoms.
// These are the same shapes emitted by `agentified analyze`; we keep them duplicated here so
// the showcase script can register them directly without shelling out to the CLI.

import type { Skill } from "agentified";

export const skills: Skill[] = [
  {
    name: "investigate_anomalous_transactions",
    description: "Find anomalous transactions, gather supporting context, and draft a CFO memo.",
    intent: "When the user wants to investigate suspicious or anomalous activity in the books and produce a written summary for finance leadership.",
    atoms: [
      "ledger_list_transactions",
      "ledger_detect_anomalies",
      "ledger_get_transaction",
      "crm_get_contact",
      "docs_search_policy",
      "docs_draft_memo",
      "comms_send_email",
    ],
    edges: [
      { from: "ledger_list_transactions", to: "ledger_detect_anomalies" },
      { from: "ledger_detect_anomalies", to: "ledger_get_transaction" },
      { from: "ledger_get_transaction", to: "crm_get_contact" },
      { from: "ledger_detect_anomalies", to: "docs_search_policy" },
      { from: "docs_search_policy", to: "docs_draft_memo" },
      { from: "crm_get_contact", to: "docs_draft_memo" },
      { from: "docs_draft_memo", to: "comms_send_email" },
    ],
  },
  {
    name: "month_end_close",
    description: "Run the month-end close: reconcile accounts, post adjusting entries, and publish the close report.",
    intent: "When the user is performing a month-end or quarter-end close and needs to coordinate reconciliation, journal entries, and reporting.",
    atoms: [
      "ledger_list_accounts",
      "ledger_reconcile_account",
      "ledger_post_journal_entry",
      "ledger_close_period",
      "docs_draft_report",
      "comms_post_slack",
    ],
    edges: [
      { from: "ledger_list_accounts", to: "ledger_reconcile_account" },
      { from: "ledger_reconcile_account", to: "ledger_post_journal_entry" },
      { from: "ledger_post_journal_entry", to: "ledger_close_period" },
      { from: "ledger_close_period", to: "docs_draft_report" },
      { from: "docs_draft_report", to: "comms_post_slack" },
    ],
  },
  {
    name: "ar_followup_campaign",
    description: "Identify overdue invoices, segment by customer health, and send tailored follow-ups.",
    intent: "When chasing accounts receivable: who's late, who matters, and what to say.",
    atoms: [
      "ledger_list_invoices",
      "ledger_get_invoice_aging",
      "crm_list_contacts",
      "crm_get_contact_health",
      "docs_draft_email",
      "comms_send_email",
    ],
    edges: [
      { from: "ledger_list_invoices", to: "ledger_get_invoice_aging" },
      { from: "ledger_get_invoice_aging", to: "crm_list_contacts" },
      { from: "crm_list_contacts", to: "crm_get_contact_health" },
      { from: "crm_get_contact_health", to: "docs_draft_email" },
      { from: "docs_draft_email", to: "comms_send_email" },
    ],
  },
  {
    name: "vendor_onboarding",
    description: "Verify a new vendor, register them in the ledger, and notify the team.",
    intent: "When onboarding a new vendor: KYC checks, ledger setup, and team notification.",
    atoms: [
      "crm_create_contact",
      "crm_run_kyc_check",
      "ledger_create_vendor",
      "ledger_set_payment_terms",
      "docs_draft_email",
      "comms_post_slack",
    ],
    edges: [
      { from: "crm_create_contact", to: "crm_run_kyc_check" },
      { from: "crm_run_kyc_check", to: "ledger_create_vendor" },
      { from: "ledger_create_vendor", to: "ledger_set_payment_terms" },
      { from: "ledger_set_payment_terms", to: "docs_draft_email" },
      { from: "docs_draft_email", to: "comms_post_slack" },
    ],
  },
  {
    name: "expense_audit",
    description: "Audit expense reports against policy, flag exceptions, and route for approval.",
    intent: "When auditing employee expense reports for policy compliance.",
    atoms: [
      "ledger_list_expense_reports",
      "docs_search_policy",
      "ledger_flag_expense_exception",
      "crm_get_contact",
      "comms_send_email",
    ],
    edges: [
      { from: "ledger_list_expense_reports", to: "docs_search_policy" },
      { from: "docs_search_policy", to: "ledger_flag_expense_exception" },
      { from: "ledger_flag_expense_exception", to: "crm_get_contact" },
      { from: "crm_get_contact", to: "comms_send_email" },
    ],
  },
];
