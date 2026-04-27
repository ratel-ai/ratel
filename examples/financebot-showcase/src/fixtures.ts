// Deterministic FinanceBot fixtures — realistic data shapes used by the ~10 tools the canned
// "investigate anomalous transactions → CFO memo" task actually invokes. Everything else stays
// stubbed in tools.ts; this file is what makes the agent loop be able to do real work.

export interface Transaction {
  id: string;
  date: string;
  vendorId: string;
  vendorName: string;
  amount: number;
  currency: string;
  account: string;
  memo: string;
  postedBy: string;
  approvedBy: string | null;
  isAnomalous: boolean;
  anomalyScore?: number;
  anomalyReason?: string;
}

export const transactions: Transaction[] = [
  // --- Normal everyday traffic (15 entries) ---------------------------------
  { id: "tx_0001", date: "2026-04-21", vendorId: "v_aws",      vendorName: "Amazon Web Services",  amount:   4_812.00, currency: "USD", account: "6100 - Cloud", memo: "March 2026 invoice", postedBy: "u_alex",  approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0002", date: "2026-04-21", vendorId: "v_gcp",      vendorName: "Google Cloud Platform", amount:   1_204.55, currency: "USD", account: "6100 - Cloud", memo: "GCP usage", postedBy: "u_alex", approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0003", date: "2026-04-21", vendorId: "v_brex",     vendorName: "Brex Card",             amount:     872.40, currency: "USD", account: "6300 - T&E", memo: "Sales offsite Q2", postedBy: "u_jess", approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0004", date: "2026-04-22", vendorId: "v_gusto",    vendorName: "Gusto",                 amount:  84_201.10, currency: "USD", account: "5000 - Payroll", memo: "April 1H payroll", postedBy: "u_alex", approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0005", date: "2026-04-22", vendorId: "v_stripe",   vendorName: "Stripe",                amount:    -312.18, currency: "USD", account: "6500 - Fees", memo: "Card fees rebate", postedBy: "u_alex", approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0006", date: "2026-04-22", vendorId: "v_office",   vendorName: "WeWork",                amount:   8_400.00, currency: "USD", account: "6200 - Rent", memo: "April HQ", postedBy: "u_alex", approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0007", date: "2026-04-23", vendorId: "v_segment",  vendorName: "Segment",               amount:   2_100.00, currency: "USD", account: "6100 - SaaS", memo: "April analytics", postedBy: "u_alex", approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0008", date: "2026-04-23", vendorId: "v_datadog",  vendorName: "Datadog",               amount:   3_660.00, currency: "USD", account: "6100 - Observability", memo: "April APM", postedBy: "u_alex", approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0009", date: "2026-04-23", vendorId: "v_legal",    vendorName: "Wilson Sonsini",        amount:  12_400.00, currency: "USD", account: "6400 - Legal", memo: "Series A docs", postedBy: "u_dana", approvedBy: "u_ceo", isAnomalous: false },
  { id: "tx_0010", date: "2026-04-24", vendorId: "v_uber",     vendorName: "Uber for Business",     amount:     412.30, currency: "USD", account: "6300 - T&E", memo: "Customer offsite rides", postedBy: "u_jess", approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0011", date: "2026-04-24", vendorId: "v_aws",      vendorName: "Amazon Web Services",   amount:     203.50, currency: "USD", account: "6100 - Cloud", memo: "Reserved instance topup", postedBy: "u_alex", approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0012", date: "2026-04-24", vendorId: "v_apollo",   vendorName: "Apollo.io",             amount:     899.00, currency: "USD", account: "6100 - SaaS", memo: "April outbound seats", postedBy: "u_jess", approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0013", date: "2026-04-25", vendorId: "v_brex",     vendorName: "Brex Card",             amount:     154.21, currency: "USD", account: "6300 - T&E", memo: "Customer dinner SF", postedBy: "u_jess", approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0014", date: "2026-04-25", vendorId: "v_zoom",     vendorName: "Zoom",                  amount:     420.00, currency: "USD", account: "6100 - SaaS", memo: "April licenses", postedBy: "u_alex", approvedBy: "u_dana", isAnomalous: false },
  { id: "tx_0015", date: "2026-04-26", vendorId: "v_aws",      vendorName: "Amazon Web Services",   amount:   5_017.40, currency: "USD", account: "6100 - Cloud", memo: "End-of-month adjustment", postedBy: "u_alex", approvedBy: "u_dana", isAnomalous: false },

  // --- ANOMALOUS (3 entries) ------------------------------------------------
  // 1) Round number, weird vendor, off-hours, no approver
  { id: "tx_0101", date: "2026-04-23", vendorId: "v_acme_consulting", vendorName: "Acme Strategic Advisors LLC", amount: 50_000.00, currency: "USD", account: "6400 - Consulting", memo: "Strategy retainer — March/April", postedBy: "u_alex", approvedBy: null, isAnomalous: true, anomalyScore: 0.94, anomalyReason: "Round-number $50k payment, vendor first-seen this month, missing approver, posted 23:47 PT" },
  // 2) Duplicate-looking vendor (Acme Strategic Advisors LLC vs Acme Strategic Advisers LLC)
  { id: "tx_0102", date: "2026-04-25", vendorId: "v_acme_advisers",   vendorName: "Acme Strategic Advisers LLC", amount: 27_500.00, currency: "USD", account: "6400 - Consulting", memo: "Q2 advisory fees", postedBy: "u_alex", approvedBy: "u_dana", isAnomalous: true, anomalyScore: 0.88, anomalyReason: "Lookalike vendor name to v_acme_consulting (one-letter diff: Advisors→Advisers); same posting employee" },
  // 3) Above policy threshold without secondary signoff
  { id: "tx_0103", date: "2026-04-26", vendorId: "v_marketing",        vendorName: "Pinnacle Growth Marketing",   amount: 18_900.00, currency: "USD", account: "6700 - Marketing", memo: "Q2 ad spend prepay", postedBy: "u_jess", approvedBy: "u_dana", isAnomalous: true, anomalyScore: 0.71, anomalyReason: "$18.9k single-payment exceeds the $10k marketing-prepay policy threshold; only single approver on file" },
];

// Vendor / contact records used by crm_get_contact for the anomalous tx
export const contacts: Record<string, {
  id: string;
  name: string;
  type: "vendor" | "customer";
  email: string;
  firstSeen: string;
  kycStatus: "verified" | "pending" | "missing";
  paymentHistory: { last90dCount: number; last90dTotal: number };
  riskFlags: string[];
}> = {
  v_acme_consulting: {
    id: "v_acme_consulting",
    name: "Acme Strategic Advisors LLC",
    type: "vendor",
    email: "billing@acme-strat.com",
    firstSeen: "2026-04-22",
    kycStatus: "missing",
    paymentHistory: { last90dCount: 0, last90dTotal: 0 },
    riskFlags: ["new-vendor-no-kyc", "single-large-payment", "posted-off-hours"],
  },
  v_acme_advisers: {
    id: "v_acme_advisers",
    name: "Acme Strategic Advisers LLC",
    type: "vendor",
    email: "ar@acmeadvisers.io",
    firstSeen: "2026-04-25",
    kycStatus: "pending",
    paymentHistory: { last90dCount: 0, last90dTotal: 0 },
    riskFlags: ["lookalike-name-to-v_acme_consulting"],
  },
  v_marketing: {
    id: "v_marketing",
    name: "Pinnacle Growth Marketing",
    type: "vendor",
    email: "billing@pinnacle-growth.com",
    firstSeen: "2025-11-04",
    kycStatus: "verified",
    paymentHistory: { last90dCount: 4, last90dTotal: 32_400 },
    riskFlags: ["above-policy-threshold-this-payment"],
  },
};

// Policy snippets returned by docs_search_policy
export const policies: Array<{ id: string; title: string; body: string; tags: string[] }> = [
  {
    id: "POL-AP-001",
    title: "AP — Vendor onboarding & KYC",
    body: "All new vendors must complete KYC verification (W-9 + bank verification + sanctions screen) before any payment is posted. Payments to vendors with kycStatus != 'verified' require CFO sign-off, regardless of amount.",
    tags: ["ap", "kyc", "vendor"],
  },
  {
    id: "POL-AP-002",
    title: "AP — Approval thresholds",
    body: "Single-payment thresholds: <$5,000 may be posted by any AP user. $5,000–$25,000 requires controller approval. >$25,000 requires both controller AND CFO approval. Marketing prepays are capped at $10,000/payment.",
    tags: ["ap", "approval", "threshold"],
  },
  {
    id: "POL-AP-003",
    title: "AP — Anomaly review SLA",
    body: "Transactions flagged with anomalyScore >= 0.7 must be reviewed by the controller within 1 business day, with a written disposition (approve / reverse / hold-for-investigation) attached to the audit log.",
    tags: ["ap", "anomaly", "controls"],
  },
  {
    id: "POL-AP-004",
    title: "AP — Lookalike vendor controls",
    body: "When two vendor records have a Levenshtein distance ≤ 2 in the legal name, the second must be flagged for de-duplication review before any payment is posted to it.",
    tags: ["ap", "duplicate", "vendor"],
  },
];
