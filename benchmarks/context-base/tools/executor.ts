import type { ToolCallPart, ToolResultPart } from "ai";

// --- Mock data (deterministic, consistent across runs) ---

const employees = [
  { id: "EMP001", name: "Marco Rossi", email: "marco.rossi@company.com", department: "Engineering", role: "Senior Engineer", startDate: "2020-03-15", managerId: "EMP003", status: "active" },
  { id: "EMP002", name: "Lisa Chen", email: "lisa.chen@company.com", department: "Engineering", role: "Engineer", startDate: "2021-06-01", managerId: "EMP003", status: "active" },
  { id: "EMP003", name: "Sarah Chen", email: "sarah.chen@company.com", department: "Engineering", role: "Engineering Manager", startDate: "2019-01-10", managerId: "EMP005", status: "active" },
  { id: "EMP004", name: "James Wilson", email: "james.wilson@company.com", department: "HR", role: "HR Director", startDate: "2018-09-01", managerId: "EMP005", status: "active" },
  { id: "EMP005", name: "Emily Davis", email: "emily.davis@company.com", department: "Executive", role: "CTO", startDate: "2017-01-01", managerId: null, status: "active" },
  { id: "EMP006", name: "Alex Kim", email: "alex.kim@company.com", department: "Marketing", role: "Marketing Lead", startDate: "2022-02-14", managerId: "EMP005", status: "active" },
  { id: "EMP007", name: "Maria Garcia", email: "maria.garcia@company.com", department: "Finance", role: "Finance Manager", startDate: "2019-11-01", managerId: "EMP005", status: "active" },
];

const salaries: Record<string, { baseSalary: number; bonus: number; currency: string }> = {
  EMP001: { baseSalary: 95000, bonus: 10000, currency: "USD" },
  EMP002: { baseSalary: 85000, bonus: 8000, currency: "USD" },
  EMP003: { baseSalary: 130000, bonus: 20000, currency: "USD" },
  EMP004: { baseSalary: 110000, bonus: 15000, currency: "USD" },
  EMP005: { baseSalary: 200000, bonus: 50000, currency: "USD" },
  EMP006: { baseSalary: 90000, bonus: 9000, currency: "USD" },
  EMP007: { baseSalary: 120000, bonus: 18000, currency: "USD" },
};

const timeOffBalances: Record<string, { vacation: number; sick: number; personal: number }> = {
  EMP001: { vacation: 15, sick: 10, personal: 3 },
  EMP002: { vacation: 12, sick: 10, personal: 3 },
  EMP003: { vacation: 20, sick: 10, personal: 5 },
  EMP004: { vacation: 18, sick: 10, personal: 4 },
  EMP005: { vacation: 25, sick: 10, personal: 5 },
  EMP006: { vacation: 10, sick: 10, personal: 3 },
  EMP007: { vacation: 16, sick: 10, personal: 4 },
};

const pendingTimeOff = [
  { requestId: "PTO-001", employeeId: "EMP002", type: "vacation", startDate: "2025-06-01", endDate: "2025-06-05", status: "pending", department: "Engineering" },
  { requestId: "PTO-002", employeeId: "EMP001", type: "personal", startDate: "2025-04-10", endDate: "2025-04-10", status: "pending", department: "Engineering" },
  { requestId: "PTO-003", employeeId: "EMP006", type: "vacation", startDate: "2025-07-01", endDate: "2025-07-10", status: "pending", department: "Marketing" },
];

const candidates = [
  { id: "CAND-001", name: "John Smith", email: "john.smith@gmail.com", status: "interviewing", appliedFor: "JOB-001", experience: 5 },
  { id: "CAND-002", name: "Jane Doe", email: "jane.doe@gmail.com", status: "applied", appliedFor: "JOB-001", experience: 3 },
  { id: "CAND-003", name: "Bob Johnson", email: "bob.j@gmail.com", status: "screening", appliedFor: "JOB-002", experience: 7 },
];

const jobPostings = [
  { id: "JOB-001", title: "Senior Engineer", department: "Engineering", status: "open", salaryMin: 100000, salaryMax: 150000 },
  { id: "JOB-002", title: "Product Manager", department: "Product", status: "open", salaryMin: 110000, salaryMax: 160000 },
];

const benefitPlans = [
  { id: "PLAN-HEALTH", name: "Health Insurance - PPO", category: "health", employeeCost: 200, employerCost: 600 },
  { id: "PLAN-DENTAL", name: "Dental Insurance", category: "dental", employeeCost: 50, employerCost: 100 },
  { id: "PLAN-VISION", name: "Vision Insurance", category: "vision", employeeCost: 25, employerCost: 50 },
  { id: "PLAN-401K", name: "401(k) Retirement", category: "retirement", employeeCost: 0, employerCost: 0 },
];

const enrolledBenefits: Record<string, string[]> = {
  EMP001: ["PLAN-HEALTH", "PLAN-401K"],
  EMP002: ["PLAN-HEALTH", "PLAN-DENTAL", "PLAN-401K"],
  EMP003: ["PLAN-HEALTH", "PLAN-DENTAL", "PLAN-VISION", "PLAN-401K"],
};

const invoices = [
  { id: "INV-001", clientId: "CLI-001", amount: 15000, status: "sent", dueDate: "2025-03-15", currency: "USD" },
  { id: "INV-002", clientId: "CLI-002", amount: 8500, status: "paid", dueDate: "2025-02-28", currency: "USD" },
];

const tickets = [
  { id: "TKT-001", title: "VPN not working", status: "open", priority: "high", requesterId: "EMP002", assigneeId: null, category: "network" },
  { id: "TKT-002", title: "Need monitor", status: "in-progress", priority: "medium", requesterId: "EMP001", assigneeId: "EMP004", category: "hardware" },
];

const assets = [
  { id: "AST-001", type: "laptop", model: "MacBook Pro 16", status: "assigned", assignedTo: "EMP001", purchaseDate: "2024-01-15" },
  { id: "AST-002", type: "monitor", model: "Dell U2723QE", status: "available", assignedTo: null, purchaseDate: "2024-03-01" },
];

const contacts = [
  { id: "CON-001", name: "Alice Johnson", email: "alice@acme.com", company: "Acme Corp", status: "customer", phone: "+1-555-0101" },
  { id: "CON-002", name: "Bob Williams", email: "bob@techstart.io", company: "TechStart", status: "lead", phone: "+1-555-0102" },
];

const deals = [
  { id: "DEAL-001", title: "Acme Enterprise License", contactId: "CON-001", value: 250000, stage: "negotiation", ownerId: "EMP006" },
  { id: "DEAL-002", title: "TechStart Pilot", contactId: "CON-002", value: 50000, stage: "qualification", ownerId: "EMP006" },
];

const projects = [
  { id: "PROJ-001", name: "Platform Redesign", status: "active", ownerId: "EMP003", startDate: "2025-01-15", endDate: "2025-06-30", budget: 500000 },
  { id: "PROJ-002", name: "Mobile App", status: "planning", ownerId: "EMP001", startDate: "2025-04-01", endDate: null, budget: 200000 },
];

const tasks = [
  { id: "TASK-001", projectId: "PROJ-001", title: "Design mockups", status: "done", assigneeId: "EMP002", dueDate: "2025-02-15" },
  { id: "TASK-002", projectId: "PROJ-001", title: "Implement API", status: "in-progress", assigneeId: "EMP001", dueDate: "2025-03-15" },
];

const vendors = [
  { id: "VND-001", name: "OfficeMax Supplies", category: "Office Supplies", status: "active", contactEmail: "sales@officemax.com", rating: 4.2 },
  { id: "VND-002", name: "CloudTech Solutions", category: "IT", status: "active", contactEmail: "support@cloudtech.com", rating: 4.5 },
];

const purchaseOrders = [
  { poId: "PO-001", vendorId: "VND-001", items: [{ description: "Office Chairs", quantity: 20, unitPrice: 350 }], total: 7000, status: "submitted", deliveryDate: "2025-03-15" },
  { poId: "PO-002", vendorId: "VND-002", items: [{ description: "Cloud hosting licenses", quantity: 10, unitPrice: 500 }], total: 5000, status: "approved", deliveryDate: "2025-02-28" },
];

const procurementContracts = [
  { id: "PC-001", vendorId: "VND-002", title: "Cloud Hosting", status: "active", startDate: "2024-01-01", endDate: "2025-12-31", value: 120000 },
];

const courses = [
  { id: "CRS-001", title: "Security Awareness", category: "compliance", durationHours: 2, mandatory: true },
  { id: "CRS-002", title: "Leadership Fundamentals", category: "leadership", durationHours: 8, mandatory: false },
];

const courseEnrollments = [
  { enrollmentId: "ENR-001", employeeId: "EMP001", courseId: "CRS-001", status: "completed", progress: 100, startDate: "2025-01-10", completedAt: "2025-01-12", score: 92 },
  { enrollmentId: "ENR-002", employeeId: "EMP001", courseId: "CRS-002", status: "in-progress", progress: 65, startDate: "2025-01-15", completedAt: null, score: null },
  { enrollmentId: "ENR-003", employeeId: "EMP002", courseId: "CRS-001", status: "completed", progress: 100, startDate: "2025-01-08", completedAt: "2025-01-09", score: 88 },
];

const certifications = [
  { id: "CERT-001", employeeId: "EMP001", title: "AWS Solutions Architect", status: "active", expiryDate: "2026-03-01" },
];

const reviews = [
  { id: "REV-001", employeeId: "EMP001", reviewerId: "EMP003", period: "H2-2024", status: "completed", rating: 4 },
  { id: "REV-002", employeeId: "EMP002", reviewerId: "EMP003", period: "H2-2024", status: "in-progress", rating: null },
];

const rooms = [
  { id: "RM-001", name: "Everest", floor: 3, capacity: 10, amenities: ["projector", "whiteboard"] },
  { id: "RM-002", name: "Alpine", floor: 2, capacity: 4, amenities: ["whiteboard"] },
];

const legalContracts = [
  { id: "LC-001", type: "service", title: "CloudTech SLA", status: "active", parties: ["Company", "CloudTech Solutions"], startDate: "2024-01-01", endDate: "2025-12-31", value: 120000 },
];

const ndas = [
  { id: "NDA-001", parties: ["Company", "TechCorp"], status: "active", effectiveDate: "2024-06-01", duration: "2 years", scope: "Product roadmap" },
];

const policies = [
  { id: "POL-001", title: "Remote Work Policy", category: "HR", status: "active", effectiveDate: "2024-01-01" },
  { id: "POL-002", title: "Data Retention Policy", category: "IT", status: "active", effectiveDate: "2024-03-15" },
];

const surveys = [
  { id: "SRV-001", title: "Employee Satisfaction Q1", status: "active", responseCount: 42, deadline: "2025-03-31" },
];

const announcements = [
  { id: "ANN-001", title: "Q1 All-Hands Meeting", content: "Join us for the quarterly all-hands...", audience: "all", date: "2025-01-15", senderId: "EMP005" },
];

export const MOCK_DATA = { employees, salaries, candidates, jobPostings, benefitPlans };

// --- Tool handler map ---

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

export const handlers: Record<string, Handler> = {
  // --- Employees ---
  getEmployee: (args) => {
    const emp = args.employeeId
      ? employees.find((e) => e.id === args.employeeId)
      : employees.find((e) => e.name === args.name);
    return emp ?? { error: "Employee not found" };
  },
  listEmployees: (args) => {
    let result = [...employees];
    if (args.department) result = result.filter((e) => e.department === args.department);
    if (args.role) result = result.filter((e) => e.role === args.role);
    if (args.status && args.status !== "all") result = result.filter((e) => e.status === args.status);
    return result;
  },
  createEmployee: (args) => ({
    id: "EMP-NEW-001",
    name: args.name,
    email: args.email,
    department: args.department,
    role: args.role,
    startDate: args.startDate,
    managerId: args.managerId ?? null,
    status: "active",
  }),
  updateEmployee: (args) => ({
    id: args.employeeId,
    updated: true,
    fields: Object.keys(args).filter((k) => k !== "employeeId"),
  }),
  deleteEmployee: (args) => ({
    id: args.employeeId,
    status: "inactive",
    reason: args.reason ?? "Deleted",
  }),
  searchEmployees: (args) => {
    const q = String(args.query).toLowerCase();
    let results = employees.filter(
      (e) => e.name.toLowerCase().includes(q) || e.role.toLowerCase().includes(q) || e.department.toLowerCase().includes(q),
    );
    if (args.limit) results = results.slice(0, Number(args.limit));
    return results;
  },
  getEmployeeHistory: (args) => [
    { date: "2020-03-15", action: "hired", details: { role: "Engineer", department: "Engineering" } },
    { date: "2022-01-01", action: "promoted", details: { role: "Senior Engineer" } },
  ],
  revokeAccess: (args) => ({
    employeeId: args.employeeId,
    accessRevoked: true,
    systems: ["email", "slack", "github", "jira"],
  }),
  archiveEmployee: (args) => ({
    employeeId: args.employeeId,
    archived: true,
    archiveDate: args.archiveDate ?? "2025-03-01",
  }),

  // --- Payroll ---
  getSalary: (args) => {
    const salary = salaries[String(args.employeeId)];
    return salary ? { employeeId: args.employeeId, ...salary } : { error: "Salary record not found" };
  },
  updateSalary: (args) => ({
    employeeId: args.employeeId,
    updated: true,
    newBaseSalary: args.baseSalary,
    effectiveDate: args.effectiveDate,
  }),
  calculatePayroll: (args) => ({
    period: args.period,
    entries: employees.map((e) => {
      const s = salaries[e.id] ?? { baseSalary: 0 };
      const gross = s.baseSalary / 12;
      const deductions = gross * 0.25;
      return { employeeId: e.id, name: e.name, gross: Math.round(gross), deductions: Math.round(deductions), net: Math.round(gross - deductions) };
    }),
    totalGross: Math.round(Object.values(salaries).reduce((sum, s) => sum + s.baseSalary / 12, 0)),
  }),
  processPayroll: (args) => ({
    period: args.period,
    processed: true,
    employeesProcessed: employees.length,
    processedAt: "2025-02-01T10:00:00Z",
  }),
  generatePayslips: (args) => ({
    period: args.period,
    payslips: (args.employeeIds as string[] | undefined ?? employees.map((e) => e.id)).map((id) => ({
      employeeId: id,
      url: `/payslips/${args.period}/${id}.pdf`,
    })),
  }),
  calculateFinalPay: (args) => {
    const salary = salaries[String(args.employeeId)];
    const base = salary?.baseSalary ?? 80000;
    return {
      employeeId: args.employeeId,
      lastDay: args.lastDay,
      remainingSalary: Math.round(base / 24),
      unusedPTO: 5 * (base / 260),
      severance: 0,
      totalFinalPay: Math.round(base / 24 + 5 * (base / 260)),
    };
  },
  getSalaryHistory: (args) => [
    { date: "2020-03-15", baseSalary: 75000, reason: "Initial" },
    { date: "2022-01-01", baseSalary: 85000, reason: "Promotion" },
    { date: "2024-01-01", baseSalary: 95000, reason: "Annual raise" },
  ],

  // --- Time-Off ---
  getTimeOffBalance: (args) => {
    const balance = timeOffBalances[String(args.employeeId)];
    if (!balance) return { error: "Employee not found" };
    if (args.type && args.type !== "all") {
      return { employeeId: args.employeeId, [String(args.type)]: balance[args.type as keyof typeof balance] };
    }
    return { employeeId: args.employeeId, ...balance };
  },
  requestTimeOff: (args) => ({
    requestId: "PTO-NEW-001",
    employeeId: args.employeeId,
    type: args.type,
    startDate: args.startDate,
    endDate: args.endDate,
    status: "pending",
  }),
  approveTimeOff: (args) => ({
    requestId: args.requestId,
    status: "approved",
    approverId: args.approverId,
    approvedAt: "2025-02-01T10:00:00Z",
  }),
  denyTimeOff: (args) => ({
    requestId: args.requestId,
    status: "denied",
    approverId: args.approverId,
    reason: args.reason,
  }),
  getPendingTimeOff: (args) => {
    let result = [...pendingTimeOff];
    if (args.department) result = result.filter((r) => r.department === args.department);
    if (args.employeeId) result = result.filter((r) => r.employeeId === args.employeeId);
    return result;
  },
  getTimeOffHistory: (args) => [
    { requestId: "PTO-H-001", type: "vacation", startDate: "2024-08-01", endDate: "2024-08-05", status: "approved" },
    { requestId: "PTO-H-002", type: "sick", startDate: "2024-10-15", endDate: "2024-10-15", status: "approved" },
  ],
  cancelTimeOff: (args) => ({
    requestId: args.requestId,
    status: "cancelled",
    cancelledAt: "2025-02-01T10:00:00Z",
  }),
  getTeamCalendar: (args) => ({
    department: args.department,
    startDate: args.startDate,
    endDate: args.endDate,
    entries: [
      { employeeId: "EMP002", name: "Lisa Chen", startDate: "2025-06-01", endDate: "2025-06-05", type: "vacation" },
    ],
  }),

  // --- Onboarding ---
  startOnboarding: (args) => ({
    employeeId: args.employeeId,
    status: "started",
    startDate: args.startDate,
    checklist: [
      { task: "Complete I-9", done: false },
      { task: "Setup workstation", done: false },
      { task: "Security training", done: false },
      { task: "Meet team", done: false },
    ],
  }),
  assignRole: (args) => ({
    employeeId: args.employeeId,
    role: args.role,
    permissions: args.permissions ?? [],
    assigned: true,
  }),
  sendWelcomeEmail: (args) => ({
    employeeId: args.employeeId,
    sent: true,
    sentAt: "2025-02-01T10:00:00Z",
  }),
  scheduleOrientation: (args) => ({
    employeeId: args.employeeId,
    date: args.date,
    format: args.format ?? "remote",
    scheduled: true,
  }),
  assignMentor: (args) => ({
    employeeId: args.employeeId,
    mentorId: args.mentorId,
    durationWeeks: args.durationWeeks ?? 4,
    assigned: true,
  }),
  getOnboardingStatus: (args) => ({
    employeeId: args.employeeId,
    status: "in_progress",
    completedTasks: 2,
    totalTasks: 4,
    checklist: [
      { task: "Complete I-9", done: true },
      { task: "Setup workstation", done: true },
      { task: "Security training", done: false },
      { task: "Meet team", done: false },
    ],
  }),

  // --- Recruiting ---
  createJobPosting: (args) => ({
    id: "JOB-NEW-001",
    title: args.title,
    department: args.department,
    description: args.description,
    requirements: args.requirements ?? [],
    salaryMin: args.salaryMin ?? null,
    salaryMax: args.salaryMax ?? null,
    status: "open",
    createdAt: "2025-02-01T10:00:00Z",
  }),
  listCandidates: (args) => {
    let result = [...candidates];
    if (args.jobPostingId) result = result.filter((c) => c.appliedFor === args.jobPostingId);
    if (args.status) result = result.filter((c) => c.status === args.status);
    return result;
  },
  scheduleInterview: (args) => ({
    candidateId: args.candidateId,
    interviewerId: args.interviewerId,
    date: args.date,
    time: args.time,
    type: args.type ?? "video",
    scheduled: true,
  }),
  sendOffer: (args) => ({
    candidateId: args.candidateId,
    salary: args.salary,
    startDate: args.startDate,
    benefits: args.benefits ?? [],
    status: "offered",
    sentAt: "2025-02-01T10:00:00Z",
  }),
  rejectCandidate: (args) => ({
    candidateId: args.candidateId,
    status: "rejected",
    reason: args.reason,
    notificationSent: args.sendNotification ?? true,
  }),
  getJobPostings: (args) => {
    let result = [...jobPostings];
    if (args.department) result = result.filter((j) => j.department === args.department);
    if (args.status) result = result.filter((j) => j.status === args.status);
    return result;
  },
  getCandidateProfile: (args) => {
    const cand = candidates.find((c) => c.id === args.candidateId);
    return cand ?? { error: "Candidate not found" };
  },

  // --- Compliance ---
  runComplianceCheck: (args) => ({
    employeeId: args.employeeId ?? null,
    department: args.department ?? null,
    checkType: args.checkType ?? "all",
    violations: [
      { type: "training", description: "Overdue security training", severity: "medium" },
    ],
    checkedAt: "2025-02-01T10:00:00Z",
  }),
  getAuditLog: () => [
    { id: "AUD-001", timestamp: "2025-01-15T09:00:00Z", userId: "EMP004", action: "salary_update", target: "EMP001" },
    { id: "AUD-002", timestamp: "2025-01-20T14:30:00Z", userId: "EMP003", action: "time_off_approved", target: "EMP002" },
    { id: "AUD-003", timestamp: "2025-01-25T11:00:00Z", userId: "EMP004", action: "employee_created", target: "EMP006" },
  ],
  generateComplianceReport: (args) => ({
    period: args.period,
    format: args.format ?? "json",
    summary: {
      totalChecks: 45,
      passed: 42,
      failed: 3,
      departments: { Engineering: { passed: 15, failed: 1 }, HR: { passed: 10, failed: 0 }, Marketing: { passed: 8, failed: 1 }, Finance: { passed: 9, failed: 1 } },
    },
    generatedAt: "2025-02-01T10:00:00Z",
  }),
  flagViolation: (args) => ({
    violationId: "VIO-001",
    employeeId: args.employeeId ?? null,
    violationType: args.violationType,
    description: args.description,
    severity: args.severity ?? "medium",
    flagged: true,
    flaggedAt: "2025-02-01T10:00:00Z",
  }),
  getComplianceStatus: (args) => ({
    department: args.department ?? "all",
    overallStatus: "compliant",
    score: 93,
    openViolations: 3,
    lastChecked: "2025-02-01T10:00:00Z",
  }),

  // --- Benefits ---
  enrollBenefits: (args) => ({
    employeeId: args.employeeId,
    planIds: args.planIds,
    effectiveDate: args.effectiveDate ?? "2025-03-01",
    enrolled: true,
  }),
  getBenefitOptions: (args) => {
    if (args.category && args.category !== "all") {
      return benefitPlans.filter((p) => p.category === args.category);
    }
    return benefitPlans;
  },
  updateBenefitElection: (args) => ({
    employeeId: args.employeeId,
    planId: args.planId,
    changes: args.changes,
    updated: true,
  }),
  calculateBenefitCost: (args) => {
    const plan = benefitPlans.find((p) => p.id === args.planId);
    return plan
      ? { planId: args.planId, employeeCost: plan.employeeCost, employerCost: plan.employerCost, totalMonthly: plan.employeeCost + plan.employerCost }
      : { error: "Plan not found" };
  },
  getEnrolledBenefits: (args) => {
    const planIds = enrolledBenefits[String(args.employeeId)] ?? [];
    return planIds.map((id) => benefitPlans.find((p) => p.id === id)).filter(Boolean);
  },

  // --- Reporting ---
  getHeadcount: (args) => {
    const base = { total: employees.length, asOf: "2025-02-01" };
    if (args.groupBy && args.groupBy !== "none") {
      const breakdown: Record<string, number> = {};
      for (const e of employees) {
        const key = e[args.groupBy as keyof typeof e] as string;
        breakdown[key] = (breakdown[key] ?? 0) + 1;
      }
      return { ...base, breakdown };
    }
    return base;
  },
  getAttrition: (args) => ({
    period: args.period,
    department: args.department ?? "all",
    rate: 4.2,
    departures: 3,
    avgHeadcount: 71,
  }),
  generateReport: (args) => ({
    reportType: args.reportType,
    period: args.period,
    filters: args.filters ?? {},
    format: args.format ?? "json",
    generatedAt: "2025-02-01T10:00:00Z",
    data: { summary: "Report generated successfully" },
  }),
  exportData: (args) => ({
    dataType: args.dataType,
    format: args.format,
    dateRange: args.dateRange ?? null,
    recordCount: 150,
    downloadUrl: `/exports/${args.dataType}_${args.format}_20250201.${args.format}`,
    expiresAt: "2025-02-02T10:00:00Z",
  }),
  getOrgChart: (args) => ({
    department: args.department ?? null,
    root: {
      id: "EMP005",
      name: "Emily Davis",
      role: "CTO",
      reports: [
        { id: "EMP003", name: "Sarah Chen", role: "Engineering Manager", reports: [
          { id: "EMP001", name: "Marco Rossi", role: "Senior Engineer", reports: [] },
          { id: "EMP002", name: "Lisa Chen", role: "Engineer", reports: [] },
        ]},
        { id: "EMP004", name: "James Wilson", role: "HR Director", reports: [] },
        { id: "EMP006", name: "Alex Kim", role: "Marketing Lead", reports: [] },
        { id: "EMP007", name: "Maria Garcia", role: "Finance Manager", reports: [] },
      ],
    },
  }),
  getDiversityMetrics: () => ({
    totalEmployees: employees.length,
    genderDistribution: { male: 3, female: 4 },
    departmentDistribution: { Engineering: 3, HR: 1, Executive: 1, Marketing: 1, Finance: 1 },
    avgTenureYears: 4.2,
  }),
  getCustomDashboard: (args) => ({
    dashboardId: args.dashboardId,
    widgets: [
      { type: "headcount", value: employees.length },
      { type: "attrition", value: 4.2 },
      { type: "openPositions", value: jobPostings.length },
    ],
  }),
  scheduleReport: (args) => ({
    scheduleId: "SCHED-001",
    reportType: args.reportType,
    frequency: args.frequency,
    recipients: args.recipients,
    nextRun: "2025-03-01T08:00:00Z",
    created: true,
  }),

  // --- Employees (new) ---
  getEmployeeDocuments: (args) => {
    const docs = [
      { id: "DOC-001", name: "Employment Contract", category: "contracts", uploadDate: "2020-03-15" },
      { id: "DOC-002", name: "ID Copy", category: "identity", uploadDate: "2020-03-15" },
      { id: "DOC-003", name: "AWS Certification", category: "certifications", uploadDate: "2024-03-01" },
    ];
    if (args.category) return docs.filter((d) => d.category === args.category);
    return docs;
  },
  uploadDocument: (args) => ({
    documentId: "DOC-NEW-001",
    employeeId: args.employeeId,
    name: args.documentName,
    category: args.category,
    uploaded: true,
    uploadedAt: "2025-02-01T10:00:00Z",
  }),

  // --- Payroll (new) ---
  getPaystub: (args) => {
    const salary = salaries[String(args.employeeId)];
    const base = salary?.baseSalary ?? 80000;
    const gross = Math.round(base / 12);
    return {
      employeeId: args.employeeId,
      period: args.period,
      gross,
      deductions: Math.round(gross * 0.25),
      net: Math.round(gross * 0.75),
      url: `/payslips/${args.period}/${args.employeeId}.pdf`,
    };
  },
  calculateBonus: (args) => {
    const salary = salaries[String(args.employeeId)];
    const base = salary?.baseSalary ?? 80000;
    const rating = (args.performanceRating as number) ?? 3;
    const multiplier = rating / 5;
    return {
      employeeId: args.employeeId,
      period: args.period,
      baseSalary: base,
      bonusPercentage: Math.round(multiplier * 15),
      bonusAmount: Math.round(base * multiplier * 0.15),
    };
  },

  // --- Recruiting (new) ---
  getApplicationStatus: (args) => {
    const cand = candidates.find((c) => c.id === args.candidateId);
    return cand
      ? { candidateId: args.candidateId, status: cand.status, appliedFor: cand.appliedFor, lastUpdate: "2025-01-20" }
      : { error: "Candidate not found" };
  },

  // --- Compliance (new) ---
  acknowledgePolicy: (args) => ({
    employeeId: args.employeeId,
    policyId: args.policyId,
    acknowledged: true,
    acknowledgedAt: "2025-02-01T10:00:00Z",
  }),

  // --- Benefits (new) ---
  compareBenefitPlans: (args) => {
    const plans = (args.planIds as string[]).map((id) => benefitPlans.find((p) => p.id === id)).filter(Boolean);
    return { plans, comparison: plans.map((p) => ({ id: p!.id, name: p!.name, employeeCost: p!.employeeCost, employerCost: p!.employerCost })) };
  },
  getBenefitsCost: (args) => {
    const planIds = enrolledBenefits[String(args.employeeId)] ?? [];
    const enrolled = planIds.map((id) => benefitPlans.find((p) => p.id === id)).filter(Boolean);
    const totalEmployee = enrolled.reduce((sum, p) => sum + p!.employeeCost, 0);
    const totalEmployer = enrolled.reduce((sum, p) => sum + p!.employerCost, 0);
    return { employeeId: args.employeeId, totalEmployeeCost: totalEmployee, totalEmployerCost: totalEmployer, planCount: enrolled.length };
  },

  // --- Time-Off (new) ---
  getHolidayCalendar: (args) => ({
    year: args.year,
    country: args.country ?? "US",
    holidays: [
      { date: `${args.year}-01-01`, name: "New Year's Day" },
      { date: `${args.year}-07-04`, name: "Independence Day" },
      { date: `${args.year}-12-25`, name: "Christmas Day" },
    ],
  }),

  // --- Onboarding (new) ---
  getOnboardingChecklist: (args) => ({
    role: args.role,
    department: args.department ?? null,
    tasks: [
      { id: "OT-001", task: "Complete I-9 form", required: true },
      { id: "OT-002", task: "Setup workstation", required: true },
      { id: "OT-003", task: "Complete security training", required: true },
      { id: "OT-004", task: "Meet team members", required: false },
      { id: "OT-005", task: "Review handbook", required: true },
    ],
  }),
  completeOnboardingTask: (args) => ({
    employeeId: args.employeeId,
    taskId: args.taskId,
    completed: true,
    completedAt: "2025-02-01T10:00:00Z",
  }),

  // --- Finance ---
  createInvoice: (args) => ({
    id: "INV-NEW-001",
    clientId: args.clientId,
    lineItems: args.lineItems,
    total: (args.lineItems as Array<{ amount: number; quantity: number }>).reduce((s, i) => s + i.amount * i.quantity, 0),
    status: "draft",
    dueDate: args.dueDate,
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getInvoice: (args) => {
    const inv = invoices.find((i) => i.id === args.invoiceId);
    return inv ?? { error: "Invoice not found" };
  },
  listInvoices: (args) => {
    let result = [...invoices];
    if (args.status && args.status !== "all") result = result.filter((i) => i.status === args.status);
    if (args.clientId) result = result.filter((i) => i.clientId === args.clientId);
    return result;
  },
  approveInvoice: (args) => ({
    invoiceId: args.invoiceId,
    approved: true,
    approverId: args.approverId,
    approvedAt: "2025-02-01T10:00:00Z",
  }),
  submitExpenseReport: (args) => ({
    reportId: "EXP-NEW-001",
    employeeId: args.employeeId,
    total: (args.expenses as Array<{ amount: number }>).reduce((s, e) => s + e.amount, 0),
    status: "pending",
    submittedAt: "2025-02-01T10:00:00Z",
  }),
  getExpenseReport: (args) => ({
    reportId: args.reportId,
    employeeId: "EMP001",
    total: 450,
    status: "pending",
    expenses: [
      { description: "Client dinner", amount: 200, category: "meals", date: "2025-01-20" },
      { description: "Taxi", amount: 50, category: "transport", date: "2025-01-20" },
    ],
  }),
  listExpenseReports: (args) => {
    const reports = [
      { reportId: "EXP-001", employeeId: "EMP001", total: 450, status: "pending" },
      { reportId: "EXP-002", employeeId: "EMP006", total: 1200, status: "approved" },
    ];
    let result = [...reports];
    if (args.employeeId) result = result.filter((r) => r.employeeId === args.employeeId);
    if (args.status && args.status !== "all") result = result.filter((r) => r.status === args.status);
    return result;
  },
  approveExpense: (args) => ({
    reportId: args.reportId,
    approved: true,
    approverId: args.approverId,
    approvedAt: "2025-02-01T10:00:00Z",
  }),
  getBudget: (args) => ({
    budgetId: "BUD-001",
    departmentId: args.departmentId ?? null,
    projectId: args.projectId ?? null,
    fiscalYear: args.fiscalYear ?? "2025",
    allocated: 500000,
    spent: 175000,
    remaining: 325000,
  }),
  updateBudget: (args) => ({
    budgetId: args.budgetId,
    newAmount: args.amount,
    reason: args.reason,
    updated: true,
  }),
  createJournalEntry: (args) => ({
    entryId: "JE-NEW-001",
    date: args.date,
    debits: args.debits,
    credits: args.credits,
    description: args.description,
    posted: true,
  }),
  getGLEntries: (args) => [
    { id: "GL-001", date: "2025-01-15", account: args.account ?? "4000", amount: 15000, type: "credit", description: "Revenue" },
    { id: "GL-002", date: "2025-01-20", account: args.account ?? "5000", amount: 8000, type: "debit", description: "Expense" },
  ],
  generateFinancialReport: (args) => ({
    reportType: args.reportType,
    period: args.period,
    format: args.format ?? "json",
    data: { revenue: 1500000, expenses: 950000, netIncome: 550000 },
    generatedAt: "2025-02-01T10:00:00Z",
  }),
  getTaxSummary: (args) => ({
    period: args.period,
    entityId: args.entityId ?? "default",
    totalWithholdings: 325000,
    totalLiabilities: 180000,
    filingStatus: "current",
  }),
  reconcileAccounts: (args) => ({
    accountId: args.accountId,
    statementDate: args.statementDate,
    statementBalance: args.statementBalance,
    glBalance: args.statementBalance - 1250,
    difference: 1250,
    status: "pending-review",
  }),
  getForecast: (args) => ({
    period: args.period,
    departmentId: args.departmentId ?? null,
    projectedRevenue: 1800000,
    projectedExpenses: 1100000,
    confidence: 0.82,
  }),

  // --- IT ---
  createTicket: (args) => ({
    id: "TKT-NEW-001",
    title: args.title,
    description: args.description,
    priority: args.priority ?? "medium",
    category: args.category ?? "other",
    requesterId: args.requesterId,
    status: "open",
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getTicket: (args) => {
    const tkt = tickets.find((t) => t.id === args.ticketId);
    return tkt ?? { error: "Ticket not found" };
  },
  listTickets: (args) => {
    let result = [...tickets];
    if (args.status && args.status !== "all") result = result.filter((t) => t.status === args.status);
    if (args.assigneeId) result = result.filter((t) => t.assigneeId === args.assigneeId);
    if (args.priority) result = result.filter((t) => t.priority === args.priority);
    return result;
  },
  updateTicket: (args) => ({
    ticketId: args.ticketId,
    updated: true,
    changes: Object.keys(args).filter((k) => k !== "ticketId"),
  }),
  assignTicket: (args) => ({
    ticketId: args.ticketId,
    assigneeId: args.assigneeId,
    assigned: true,
  }),
  resolveTicket: (args) => ({
    ticketId: args.ticketId,
    resolution: args.resolution,
    resolvedById: args.resolvedById,
    status: "resolved",
    resolvedAt: "2025-02-01T10:00:00Z",
  }),
  getAsset: (args) => {
    const ast = assets.find((a) => a.id === args.assetId);
    return ast ?? { error: "Asset not found" };
  },
  listAssets: (args) => {
    let result = [...assets];
    if (args.type && args.type !== "all") result = result.filter((a) => a.type === args.type);
    if (args.status && args.status !== "all") result = result.filter((a) => a.status === args.status);
    if (args.assignedTo) result = result.filter((a) => a.assignedTo === args.assignedTo);
    return result;
  },
  assignAsset: (args) => ({
    assetId: args.assetId,
    employeeId: args.employeeId,
    assigned: true,
    assignedAt: "2025-02-01T10:00:00Z",
  }),
  retireAsset: (args) => ({
    assetId: args.assetId,
    reason: args.reason,
    disposalMethod: args.disposalMethod ?? "recycle",
    retired: true,
  }),
  getSoftwareLicense: (args) => ({
    licenseId: args.licenseId,
    software: "Jira",
    vendor: "Atlassian",
    totalSeats: 50,
    usedSeats: 42,
    expiryDate: "2025-12-31",
  }),
  listSoftwareLicenses: () => [
    { licenseId: "LIC-001", software: "Jira", vendor: "Atlassian", totalSeats: 50, usedSeats: 42, expiryDate: "2025-12-31" },
    { licenseId: "LIC-002", software: "Figma", vendor: "Figma Inc", totalSeats: 20, usedSeats: 15, expiryDate: "2025-09-30" },
  ],
  requestAccess: (args) => ({
    requestId: "ACC-NEW-001",
    employeeId: args.employeeId,
    systemName: args.systemName,
    accessLevel: args.accessLevel ?? "read",
    status: "pending-approval",
  }),
  revokeSystemAccess: (args) => ({
    employeeId: args.employeeId,
    systemName: args.systemName,
    reason: args.reason,
    revoked: true,
    revokedAt: "2025-02-01T10:00:00Z",
  }),
  getAccessPermissions: (args) => ({
    employeeId: args.employeeId,
    permissions: [
      { system: "Jira", level: "write", grantedAt: "2021-06-01" },
      { system: "GitHub", level: "admin", grantedAt: "2021-06-01" },
      { system: "Slack", level: "write", grantedAt: "2021-06-01" },
    ],
  }),
  generateITReport: (args) => ({
    reportType: args.reportType,
    period: args.period,
    format: args.format ?? "json",
    data: { openTickets: 12, resolvedThisPeriod: 45, assetsInService: 150, licensesExpiringSoon: 3 },
    generatedAt: "2025-02-01T10:00:00Z",
  }),

  // --- CRM ---
  createContact: (args) => ({
    id: "CON-NEW-001",
    name: args.name,
    email: args.email,
    company: args.company ?? null,
    status: "lead",
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getContact: (args) => {
    const con = contacts.find((c) => c.id === args.contactId);
    return con ?? { error: "Contact not found" };
  },
  listContacts: (args) => {
    let result = [...contacts];
    if (args.company) result = result.filter((c) => c.company === args.company);
    if (args.status && args.status !== "all") result = result.filter((c) => c.status === args.status);
    if (args.limit) result = result.slice(0, Number(args.limit));
    return result;
  },
  updateContact: (args) => ({
    contactId: args.contactId,
    updated: true,
    fields: Object.keys(args).filter((k) => k !== "contactId"),
  }),
  createDeal: (args) => ({
    id: "DEAL-NEW-001",
    title: args.title,
    contactId: args.contactId,
    value: args.value,
    stage: args.stage ?? "prospecting",
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getDeal: (args) => {
    const deal = deals.find((d) => d.id === args.dealId);
    return deal ?? { error: "Deal not found" };
  },
  listDeals: (args) => {
    let result = [...deals];
    if (args.stage && args.stage !== "all") result = result.filter((d) => d.stage === args.stage);
    if (args.ownerId) result = result.filter((d) => d.ownerId === args.ownerId);
    return result;
  },
  updateDeal: (args) => ({
    dealId: args.dealId,
    updated: true,
    changes: Object.keys(args).filter((k) => k !== "dealId"),
  }),
  getPipeline: () => ({
    stages: [
      { name: "prospecting", count: 5, value: 150000 },
      { name: "qualification", count: 3, value: 120000 },
      { name: "proposal", count: 2, value: 200000 },
      { name: "negotiation", count: 1, value: 250000 },
    ],
    totalValue: 720000,
  }),
  createQuote: (args) => ({
    id: "QTE-NEW-001",
    dealId: args.dealId,
    lineItems: args.lineItems,
    total: (args.lineItems as Array<{ quantity: number; unitPrice: number }>).reduce((s, i) => s + i.quantity * i.unitPrice, 0),
    discount: args.discount ?? 0,
    validUntil: args.validUntil,
    status: "draft",
  }),
  getQuote: (args) => ({
    quoteId: args.quoteId,
    dealId: "DEAL-001",
    total: 230000,
    status: "sent",
    validUntil: "2025-03-31",
  }),
  sendQuote: (args) => ({
    quoteId: args.quoteId,
    recipientEmail: args.recipientEmail,
    sent: true,
    sentAt: "2025-02-01T10:00:00Z",
  }),
  getSalesForecast: (args) => ({
    period: args.period,
    teamId: args.teamId ?? null,
    projectedRevenue: 850000,
    weightedPipeline: 620000,
    confidence: 0.75,
  }),
  logActivity: (args) => ({
    activityId: "ACT-NEW-001",
    contactId: args.contactId ?? null,
    dealId: args.dealId ?? null,
    type: args.type,
    description: args.description,
    logged: true,
  }),
  getContactHistory: (args) => [
    { date: "2025-01-10", type: "email", description: "Sent proposal" },
    { date: "2025-01-15", type: "call", description: "Follow-up call" },
    { date: "2025-01-25", type: "meeting", description: "Product demo" },
  ],
  generateSalesReport: (args) => ({
    period: args.period,
    format: args.format ?? "json",
    data: { totalRevenue: 750000, dealsWon: 8, dealsLost: 3, conversionRate: 0.73 },
    generatedAt: "2025-02-01T10:00:00Z",
  }),

  // --- Projects ---
  createProject: (args) => ({
    id: "PROJ-NEW-001",
    name: args.name,
    description: args.description,
    ownerId: args.ownerId,
    status: "planning",
    startDate: args.startDate,
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getProject: (args) => {
    const proj = projects.find((p) => p.id === args.projectId);
    return proj ?? { error: "Project not found" };
  },
  listProjects: (args) => {
    let result = [...projects];
    if (args.status && args.status !== "all") result = result.filter((p) => p.status === args.status);
    if (args.ownerId) result = result.filter((p) => p.ownerId === args.ownerId);
    return result;
  },
  updateProject: (args) => ({
    projectId: args.projectId,
    updated: true,
    changes: Object.keys(args).filter((k) => k !== "projectId"),
  }),
  createTask: (args) => ({
    id: "TASK-NEW-001",
    projectId: args.projectId,
    title: args.title,
    assigneeId: args.assigneeId ?? null,
    status: "todo",
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getTask: (args) => {
    const task = tasks.find((t) => t.id === args.taskId);
    return task ?? { error: "Task not found" };
  },
  listTasks: (args) => {
    let result = [...tasks];
    if (args.projectId) result = result.filter((t) => t.projectId === args.projectId);
    if (args.assigneeId) result = result.filter((t) => t.assigneeId === args.assigneeId);
    if (args.status && args.status !== "all") result = result.filter((t) => t.status === args.status);
    return result;
  },
  updateTask: (args) => ({
    taskId: args.taskId,
    updated: true,
    changes: Object.keys(args).filter((k) => k !== "taskId"),
  }),
  assignTask: (args) => ({
    taskId: args.taskId,
    assigneeId: args.assigneeId,
    assigned: true,
  }),
  getMilestones: (args) => ([
    { id: "MS-001", projectId: args.projectId, title: "Design Complete", status: "completed", targetDate: "2025-02-01" },
    { id: "MS-002", projectId: args.projectId, title: "MVP Launch", status: "in-progress", targetDate: "2025-04-15" },
  ]),
  updateMilestone: (args) => ({
    milestoneId: args.milestoneId,
    updated: true,
    changes: Object.keys(args).filter((k) => k !== "milestoneId"),
  }),
  logTimeEntry: (args) => ({
    entryId: "TE-NEW-001",
    taskId: args.taskId,
    employeeId: args.employeeId,
    hours: args.hours,
    date: args.date,
    logged: true,
  }),
  getTimesheets: (args) => [
    { entryId: "TE-001", employeeId: args.employeeId ?? "EMP001", projectId: args.projectId ?? "PROJ-001", hours: 8, date: "2025-02-01", task: "API implementation" },
    { entryId: "TE-002", employeeId: args.employeeId ?? "EMP001", projectId: args.projectId ?? "PROJ-001", hours: 6, date: "2025-02-02", task: "Code review" },
  ],
  generateProjectReport: (args) => ({
    projectId: args.projectId,
    format: args.format ?? "json",
    data: { progress: 45, budgetUsed: 175000, budgetTotal: 500000, tasksCompleted: 12, tasksTotal: 28 },
    generatedAt: "2025-02-01T10:00:00Z",
  }),
  getProjectBudget: (args) => {
    const proj = projects.find((p) => p.id === args.projectId);
    return {
      projectId: args.projectId,
      totalBudget: proj?.budget ?? 100000,
      spent: 175000,
      remaining: (proj?.budget ?? 100000) - 175000,
      burnRate: 25000,
    };
  },

  // --- Procurement ---
  createPurchaseOrder: (args) => ({
    id: "PO-NEW-001",
    vendorId: args.vendorId,
    items: args.items,
    total: (args.items as Array<{ quantity: number; unitPrice: number }>).reduce((s, i) => s + i.quantity * i.unitPrice, 0),
    status: "draft",
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getPurchaseOrder: (args) => {
    const po = purchaseOrders.find((o) => o.poId === args.poId);
    return po ?? { error: "Purchase order not found" };
  },
  listPurchaseOrders: (args) => {
    let result = [...purchaseOrders];
    if (args.vendorId) result = result.filter((o) => o.vendorId === args.vendorId);
    if (args.status && args.status !== "all") result = result.filter((o) => o.status === args.status);
    return result;
  },
  approvePurchaseOrder: (args) => ({
    poId: args.poId,
    approved: true,
    approverId: args.approverId,
    approvedAt: "2025-02-01T10:00:00Z",
  }),
  getVendor: (args) => {
    const vnd = vendors.find((v) => v.id === args.vendorId);
    return vnd ?? { error: "Vendor not found" };
  },
  listVendors: (args) => {
    let result = [...vendors];
    if (args.category) result = result.filter((v) => v.category === args.category);
    if (args.status && args.status !== "all") result = result.filter((v) => v.status === args.status);
    return result;
  },
  createVendor: (args) => ({
    id: "VND-NEW-001",
    name: args.name,
    category: args.category,
    contactEmail: args.contactEmail,
    status: "active",
    createdAt: "2025-02-01T10:00:00Z",
  }),
  updateVendor: (args) => ({
    vendorId: args.vendorId,
    updated: true,
    changes: Object.keys(args).filter((k) => k !== "vendorId"),
  }),
  rateVendor: (args) => ({
    vendorId: args.vendorId,
    rating: args.rating,
    review: args.review ?? null,
    rated: true,
  }),
  getProcurementContract: (args) => {
    const pc = procurementContracts.find((c) => c.id === args.contractId);
    return pc ?? { error: "Contract not found" };
  },
  listProcurementContracts: (args) => {
    let result = [...procurementContracts];
    if (args.vendorId) result = result.filter((c) => c.vendorId === args.vendorId);
    if (args.status && args.status !== "all") result = result.filter((c) => c.status === args.status);
    return result;
  },
  renewContract: (args) => ({
    contractId: args.contractId,
    newEndDate: args.newEndDate,
    renewed: true,
    renewedAt: "2025-02-01T10:00:00Z",
  }),
  getInventoryLevel: (args) => ({
    productId: args.productId ?? null,
    category: args.category ?? null,
    currentStock: 250,
    reorderLevel: 50,
    lastUpdated: "2025-02-01",
  }),
  updateInventory: (args) => ({
    productId: args.productId,
    adjustment: args.adjustment,
    reason: args.reason,
    newLevel: 250 + Number(args.adjustment),
    updated: true,
  }),
  generateProcurementReport: (args) => ({
    period: args.period,
    format: args.format ?? "json",
    data: { totalSpend: 450000, vendorCount: 25, ordersPlaced: 78, avgOrderValue: 5769 },
    generatedAt: "2025-02-01T10:00:00Z",
  }),

  // --- Training ---
  createCourse: (args) => ({
    id: "CRS-NEW-001",
    title: args.title,
    description: args.description,
    category: args.category,
    durationHours: args.durationHours,
    mandatory: args.mandatory ?? false,
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getCourse: (args) => {
    const crs = courses.find((c) => c.id === args.courseId);
    return crs ?? { error: "Course not found" };
  },
  listCourses: (args) => {
    let result = [...courses];
    if (args.category) result = result.filter((c) => c.category === args.category);
    if (args.mandatory !== undefined) result = result.filter((c) => c.mandatory === args.mandatory);
    return result;
  },
  enrollInCourse: (args) => ({
    enrollmentId: "ENR-NEW-001",
    employeeId: args.employeeId,
    courseId: args.courseId,
    dueDate: args.dueDate ?? null,
    status: "enrolled",
  }),
  listCourseEnrollments: (args) => {
    let result = [...courseEnrollments];
    if (args.employeeId) result = result.filter((e) => e.employeeId === args.employeeId);
    if (args.status && args.status !== "all") result = result.filter((e) => e.status === args.status);
    return result.map((e) => {
      const course = courses.find((c) => c.id === e.courseId);
      return { ...e, courseTitle: course?.title ?? null };
    });
  },
  getCourseProgress: (args) => {
    const enrollment = courseEnrollments.find(
      (e) => e.employeeId === args.employeeId && e.courseId === args.courseId,
    );
    if (!enrollment) return { error: "No enrollment found for this employee and course" };
    return {
      employeeId: enrollment.employeeId,
      courseId: enrollment.courseId,
      progress: enrollment.progress,
      status: enrollment.status,
      startDate: enrollment.startDate,
      completedAt: enrollment.completedAt,
      score: enrollment.score,
    };
  },
  completeCourse: (args) => ({
    employeeId: args.employeeId,
    courseId: args.courseId,
    score: args.score ?? null,
    status: "completed",
    completedAt: "2025-02-01T10:00:00Z",
  }),
  getCertification: (args) => {
    const cert = certifications.find((c) => c.id === args.certificationId);
    return cert ?? { error: "Certification not found" };
  },
  listCertifications: (args) => {
    let result = [...certifications];
    if (args.employeeId) result = result.filter((c) => c.employeeId === args.employeeId);
    if (args.status && args.status !== "all") result = result.filter((c) => c.status === args.status);
    return result;
  },
  renewCertification: (args) => ({
    certificationId: args.certificationId,
    employeeId: args.employeeId,
    renewalDate: args.renewalDate,
    renewed: true,
  }),
  createAssessment: (args) => ({
    id: "ASMT-NEW-001",
    courseId: args.courseId,
    title: args.title,
    passingScore: args.passingScore,
    questions: args.questions,
    createdAt: "2025-02-01T10:00:00Z",
  }),
  submitAssessment: (args) => ({
    assessmentId: args.assessmentId,
    employeeId: args.employeeId,
    score: 85,
    passed: true,
    submittedAt: "2025-02-01T10:00:00Z",
  }),
  getTrainingReport: (args) => ({
    period: args.period,
    department: args.department ?? "all",
    format: args.format ?? "json",
    data: { coursesCompleted: 120, employeesTrained: 45, avgScore: 82, complianceRate: 0.94 },
    generatedAt: "2025-02-01T10:00:00Z",
  }),

  // --- Performance ---
  createReview: (args) => ({
    id: "REV-NEW-001",
    employeeId: args.employeeId,
    reviewerId: args.reviewerId,
    period: args.period,
    type: args.type ?? "annual",
    status: "draft",
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getReview: (args) => {
    const rev = reviews.find((r) => r.id === args.reviewId);
    return rev ?? { error: "Review not found" };
  },
  listReviews: (args) => {
    let result = [...reviews];
    if (args.employeeId) result = result.filter((r) => r.employeeId === args.employeeId);
    if (args.reviewerId) result = result.filter((r) => r.reviewerId === args.reviewerId);
    if (args.status && args.status !== "all") result = result.filter((r) => r.status === args.status);
    return result;
  },
  submitSelfAssessment: (args) => ({
    reviewId: args.reviewId,
    employeeId: args.employeeId,
    submitted: true,
    submittedAt: "2025-02-01T10:00:00Z",
  }),
  submitPeerFeedback: (args) => ({
    reviewId: args.reviewId,
    feedbackFromId: args.feedbackFromId,
    submitted: true,
    submittedAt: "2025-02-01T10:00:00Z",
  }),
  setGoals: (args) => ({
    employeeId: args.employeeId,
    period: args.period,
    goalsSet: (args.goals as unknown[]).length,
    created: true,
  }),
  getGoals: (args) => ({
    employeeId: args.employeeId,
    period: args.period ?? "H1-2025",
    goals: [
      { id: "GOAL-001", title: "Ship v2 API", progress: 60, dueDate: "2025-06-30" },
      { id: "GOAL-002", title: "Mentor 2 juniors", progress: 50, dueDate: "2025-06-30" },
    ],
  }),
  updateGoalProgress: (args) => ({
    goalId: args.goalId,
    progress: args.progress,
    notes: args.notes ?? null,
    updated: true,
  }),
  createOKR: (args) => ({
    id: "OKR-NEW-001",
    ownerId: args.ownerId,
    objective: args.objective,
    keyResults: args.keyResults,
    period: args.period,
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getOKRs: (args) => ({
    ownerId: args.ownerId ?? null,
    period: args.period ?? "Q1-2025",
    okrs: [
      { id: "OKR-001", objective: "Improve platform reliability", progress: 70, keyResults: [{ description: "99.9% uptime", current: 99.85, target: 99.9 }] },
    ],
  }),
  requestFeedback: (args) => ({
    employeeId: args.employeeId,
    reviewerIds: args.reviewerIds,
    requestsSent: (args.reviewerIds as string[]).length,
    requested: true,
  }),
  generatePerformanceReport: (args) => ({
    period: args.period,
    department: args.department ?? "all",
    format: args.format ?? "json",
    data: { avgRating: 3.8, reviewsCompleted: 45, goalsAchieved: 0.72 },
    generatedAt: "2025-02-01T10:00:00Z",
  }),

  // --- Facilities ---
  bookRoom: (args) => ({
    bookingId: "BK-NEW-001",
    roomId: args.roomId,
    date: args.date,
    startTime: args.startTime,
    endTime: args.endTime,
    organizerId: args.organizerId,
    booked: true,
  }),
  listRooms: (args) => {
    let result = [...rooms];
    if (args.floor) result = result.filter((r) => r.floor === args.floor);
    if (args.minCapacity) result = result.filter((r) => r.capacity >= (args.minCapacity as number));
    return result;
  },
  cancelRoomBooking: (args) => ({
    bookingId: args.bookingId,
    cancelled: true,
    cancelledAt: "2025-02-01T10:00:00Z",
  }),
  getRoomSchedule: (args) => ({
    roomId: args.roomId,
    date: args.date,
    bookings: [
      { startTime: "09:00", endTime: "10:00", title: "Standup", organizer: "EMP003" },
      { startTime: "14:00", endTime: "15:00", title: "Design Review", organizer: "EMP001" },
    ],
  }),
  requestEquipment: (args) => ({
    requestId: "EQ-NEW-001",
    employeeId: args.employeeId,
    equipmentType: args.equipmentType,
    quantity: args.quantity ?? 1,
    status: "submitted",
  }),
  getEquipmentStatus: (args) => ({
    requestId: args.requestId,
    status: "approved",
    estimatedDelivery: "2025-02-15",
  }),
  submitMaintenanceRequest: (args) => ({
    requestId: "MNT-NEW-001",
    location: args.location,
    issueType: args.issueType,
    description: args.description,
    priority: args.priority ?? "medium",
    status: "open",
  }),
  getMaintenanceStatus: (args) => ({
    requestId: args.requestId,
    status: "in-progress",
    assignedTo: "Facilities Team",
    estimatedCompletion: "2025-02-05",
  }),
  listMaintenanceRequests: (args) => {
    const reqs = [
      { requestId: "MNT-001", location: "Floor 3", issueType: "hvac", status: "open", priority: "high" },
      { requestId: "MNT-002", location: "Floor 2", issueType: "plumbing", status: "in-progress", priority: "medium" },
    ];
    let result = [...reqs];
    if (args.status && args.status !== "all") result = result.filter((r) => r.status === args.status);
    if (args.location) result = result.filter((r) => r.location === args.location);
    if (args.priority) result = result.filter((r) => r.priority === args.priority);
    return result;
  },
  getFloorPlan: (args) => ({
    building: args.building ?? "HQ",
    floor: args.floor ?? 1,
    desks: 40,
    rooms: 6,
    availableDesks: 12,
  }),
  reserveDesk: (args) => ({
    deskId: args.deskId,
    employeeId: args.employeeId,
    date: args.date,
    reserved: true,
  }),
  generateFacilitiesReport: (args) => ({
    period: args.period,
    building: args.building ?? "all",
    format: args.format ?? "json",
    data: { roomUtilization: 0.72, deskUtilization: 0.68, maintenanceRequests: 34, avgResolutionDays: 2.1 },
    generatedAt: "2025-02-01T10:00:00Z",
  }),

  // --- Legal ---
  createLegalContract: (args) => ({
    id: "LC-NEW-001",
    type: args.type,
    title: args.title,
    parties: args.parties,
    startDate: args.startDate,
    status: "draft",
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getLegalContract: (args) => {
    const lc = legalContracts.find((c) => c.id === args.contractId);
    return lc ?? { error: "Contract not found" };
  },
  listLegalContracts: (args) => {
    let result = [...legalContracts];
    if (args.type && args.type !== "all") result = result.filter((c) => c.type === args.type);
    if (args.status && args.status !== "all") result = result.filter((c) => c.status === args.status);
    return result;
  },
  requestContractReview: (args) => ({
    reviewId: "CR-NEW-001",
    contractId: args.contractId,
    requesterId: args.requesterId,
    urgency: args.urgency ?? "standard",
    status: "pending",
  }),
  getContractReviewStatus: (args) => ({
    reviewId: args.reviewId,
    status: "in-progress",
    assignedTo: "Legal Team",
    estimatedCompletion: "2025-02-10",
  }),
  createNDA: (args) => ({
    id: "NDA-NEW-001",
    parties: args.parties,
    scope: args.scope,
    duration: args.duration,
    effectiveDate: args.effectiveDate,
    status: "draft",
  }),
  getNDA: (args) => {
    const nda = ndas.find((n) => n.id === args.ndaId);
    return nda ?? { error: "NDA not found" };
  },
  listNDAs: (args) => {
    let result = [...ndas];
    if (args.status && args.status !== "all") result = result.filter((n) => n.status === args.status);
    if (args.party) result = result.filter((n) => n.parties.some((p: string) => p.includes(args.party as string)));
    return result;
  },
  getPolicy: (args) => {
    const pol = policies.find((p) => p.id === args.policyId);
    return pol ?? { error: "Policy not found" };
  },
  listPolicies: (args) => {
    let result = [...policies];
    if (args.category) result = result.filter((p) => p.category === args.category);
    if (args.status && args.status !== "all") result = result.filter((p) => p.status === args.status);
    return result;
  },
  updatePolicy: (args) => ({
    policyId: args.policyId,
    updated: true,
    changes: Object.keys(args).filter((k) => k !== "policyId"),
  }),
  generateLegalReport: (args) => ({
    period: args.period,
    format: args.format ?? "json",
    data: { activeContracts: 25, expiringContracts: 4, activeNDAs: 12, pendingReviews: 6 },
    generatedAt: "2025-02-01T10:00:00Z",
  }),

  // --- Communications ---
  sendAnnouncement: (args) => ({
    id: "ANN-NEW-001",
    title: args.title,
    audience: args.audience ?? "all",
    sent: true,
    sentAt: "2025-02-01T10:00:00Z",
  }),
  getAnnouncement: (args) => {
    const ann = announcements.find((a) => a.id === args.announcementId);
    return ann ?? { error: "Announcement not found" };
  },
  listAnnouncements: (args) => {
    let result = [...announcements];
    if (args.audience) result = result.filter((a) => a.audience === args.audience);
    if (args.limit) result = result.slice(0, Number(args.limit));
    return result;
  },
  createSurvey: (args) => ({
    id: "SRV-NEW-001",
    title: args.title,
    description: args.description,
    questionCount: (args.questions as unknown[]).length,
    anonymous: args.anonymous ?? false,
    status: "draft",
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getSurvey: (args) => {
    const srv = surveys.find((s) => s.id === args.surveyId);
    return srv ?? { error: "Survey not found" };
  },
  listSurveys: (args) => {
    let result = [...surveys];
    if (args.status && args.status !== "all") result = result.filter((s) => s.status === args.status);
    return result;
  },
  getSurveyResults: (args) => ({
    surveyId: args.surveyId,
    totalResponses: 42,
    completionRate: 0.84,
    results: [
      { questionId: "Q1", question: "Overall satisfaction", avgRating: 4.2 },
      { questionId: "Q2", question: "Work-life balance", avgRating: 3.8 },
    ],
  }),
  submitSurveyResponse: (args) => ({
    surveyId: args.surveyId,
    respondentId: args.respondentId ?? "anonymous",
    submitted: true,
    submittedAt: "2025-02-01T10:00:00Z",
  }),
  createNewsletter: (args) => ({
    id: "NL-NEW-001",
    title: args.title,
    scheduledDate: args.scheduledDate ?? null,
    status: "draft",
    createdAt: "2025-02-01T10:00:00Z",
  }),
  getNewsletter: (args) => ({
    newsletterId: args.newsletterId,
    title: "February Company Update",
    status: "sent",
    sentDate: "2025-02-01",
    openRate: 0.72,
  }),
  sendNewsletter: (args) => ({
    newsletterId: args.newsletterId,
    audience: args.audience ?? "all",
    sent: true,
    sentAt: "2025-02-01T10:00:00Z",
  }),
  generateCommunicationsReport: (args) => ({
    period: args.period,
    format: args.format ?? "json",
    data: { announcementsSent: 12, surveysCompleted: 3, newslettersSent: 4, avgOpenRate: 0.68 },
    generatedAt: "2025-02-01T10:00:00Z",
  }),
};

// --- Executor factory ---

export function createToolExecutor(): (call: ToolCallPart) => Promise<ToolResultPart> {
  return async (call: ToolCallPart): Promise<ToolResultPart> => {
    const handler = handlers[call.toolName];
    if (!handler) throw new Error(`Unknown tool: ${call.toolName}`);

    const result = handler((call.args ?? {}) as Args);

    return {
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      result: result as ToolResultPart["result"],
    };
  };
}
