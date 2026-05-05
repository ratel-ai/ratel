import { describe, expect, it } from "vitest";
import { createToolExecutor, MOCK_DATA } from "./executor.js";

describe("createToolExecutor", () => {
  const executor = createToolExecutor();

  it("returns a function", () => {
    expect(typeof executor).toBe("function");
  });

  it("throws on unknown tool", async () => {
    await expect(
      executor({
        type: "tool-call",
        toolCallId: "1",
        toolName: "nonExistentTool",
        args: {},
      }),
    ).rejects.toThrow("Unknown tool: nonExistentTool");
  });

  it("returns ToolResultPart shape", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "getEmployee",
      args: { name: "Marco Rossi" },
    });
    expect(result).toMatchObject({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "getEmployee",
    });
    expect(result.result).toBeDefined();
  });

  it("is async (returns promise)", () => {
    const result = executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getEmployee",
      args: { name: "Marco Rossi" },
    });
    expect(result).toBeInstanceOf(Promise);
  });

  describe("determinism", () => {
    it("returns same result for same input", async () => {
      const args = { name: "Marco Rossi" };
      const r1 = await executor({
        type: "tool-call",
        toolCallId: "a",
        toolName: "getEmployee",
        args,
      });
      const r2 = await executor({
        type: "tool-call",
        toolCallId: "b",
        toolName: "getEmployee",
        args,
      });
      expect(r1.result).toEqual(r2.result);
    });
  });
});

describe("employee tools", () => {
  const executor = createToolExecutor();

  it("getEmployee by name returns Marco Rossi", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getEmployee",
      args: { name: "Marco Rossi" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({
      id: "EMP001",
      name: "Marco Rossi",
      department: "Engineering",
    });
  });

  it("getEmployee by id", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getEmployee",
      args: { employeeId: "EMP002" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ id: "EMP002", name: "Lisa Chen" });
  });

  it("getEmployee returns not found for unknown", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getEmployee",
      args: { name: "Nobody" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ error: "Employee not found" });
  });

  it("listEmployees returns all", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "listEmployees",
      args: {},
    });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(5);
  });

  it("listEmployees filters by department", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "listEmployees",
      args: { department: "Engineering" },
    });
    const data = result.result as Array<Record<string, unknown>>;
    expect(data.every((e) => e.department === "Engineering")).toBe(true);
  });

  it("createEmployee returns new record", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "createEmployee",
      args: {
        name: "Test User",
        email: "test@co.com",
        department: "HR",
        role: "Analyst",
        startDate: "2025-03-01",
      },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ name: "Test User", status: "active" });
    expect(data.id).toBeDefined();
  });

  it("updateEmployee returns updated fields", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "updateEmployee",
      args: { employeeId: "EMP001", email: "marco@newdomain.com" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ id: "EMP001", updated: true });
  });

  it("deleteEmployee soft-deletes", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "deleteEmployee",
      args: { employeeId: "EMP001" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ id: "EMP001", status: "inactive" });
  });

  it("searchEmployees returns matches", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "searchEmployees",
      args: { query: "Marco" },
    });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("getEmployeeHistory returns history", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getEmployeeHistory",
      args: { employeeId: "EMP001" },
    });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("revokeAccess returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "revokeAccess",
      args: { employeeId: "EMP001" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP001", accessRevoked: true });
  });

  it("archiveEmployee returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "archiveEmployee",
      args: { employeeId: "EMP001" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP001", archived: true });
  });
});

describe("payroll tools", () => {
  const executor = createToolExecutor();

  it("getSalary returns salary info", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getSalary",
      args: { employeeId: "EMP001" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP001", currency: "USD" });
    expect(data.baseSalary).toBeDefined();
  });

  it("updateSalary returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "updateSalary",
      args: {
        employeeId: "EMP001",
        baseSalary: 110000,
        effectiveDate: "2025-04-01",
        reason: "Annual raise",
      },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP001", updated: true });
  });

  it("calculatePayroll returns payroll data", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "calculatePayroll",
      args: { period: "2025-01" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("period", "2025-01");
    expect(data).toHaveProperty("entries");
  });

  it("processPayroll returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "processPayroll",
      args: { period: "2025-01" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ period: "2025-01", processed: true });
  });

  it("generatePayslips returns payslip data", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "generatePayslips",
      args: { period: "2025-01" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("period", "2025-01");
    expect(data).toHaveProperty("payslips");
  });

  it("calculateFinalPay returns final pay breakdown", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "calculateFinalPay",
      args: { employeeId: "EMP001", lastDay: "2025-03-31" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP001" });
    expect(data).toHaveProperty("totalFinalPay");
  });

  it("getSalaryHistory returns history", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getSalaryHistory",
      args: { employeeId: "EMP001" },
    });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("timeoff tools", () => {
  const executor = createToolExecutor();

  it("getTimeOffBalance returns balances", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getTimeOffBalance",
      args: { employeeId: "EMP002" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP002" });
    expect(data).toHaveProperty("vacation");
  });

  it("requestTimeOff returns request id", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "requestTimeOff",
      args: {
        employeeId: "EMP002",
        type: "vacation",
        startDate: "2025-06-01",
        endDate: "2025-06-05",
      },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("requestId");
    expect(data).toMatchObject({ status: "pending" });
  });

  it("approveTimeOff returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "approveTimeOff",
      args: { requestId: "PTO-001", approverId: "EMP003" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ requestId: "PTO-001", status: "approved" });
  });

  it("denyTimeOff returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "denyTimeOff",
      args: {
        requestId: "PTO-002",
        approverId: "EMP003",
        reason: "Team capacity",
      },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ requestId: "PTO-002", status: "denied" });
  });

  it("getPendingTimeOff returns pending requests", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getPendingTimeOff",
      args: {},
    });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("getTimeOffHistory returns history", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getTimeOffHistory",
      args: { employeeId: "EMP002" },
    });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("cancelTimeOff returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "cancelTimeOff",
      args: { requestId: "PTO-001" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ requestId: "PTO-001", status: "cancelled" });
  });

  it("getTeamCalendar returns calendar", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getTeamCalendar",
      args: {
        department: "Engineering",
        startDate: "2025-06-01",
        endDate: "2025-06-30",
      },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("department", "Engineering");
    expect(data).toHaveProperty("entries");
  });
});

describe("onboarding tools", () => {
  const executor = createToolExecutor();

  it("startOnboarding returns checklist", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "startOnboarding",
      args: { employeeId: "EMP006", startDate: "2025-03-03" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP006", status: "started" });
    expect(data).toHaveProperty("checklist");
  });

  it("assignRole returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "assignRole",
      args: { employeeId: "EMP006", role: "Engineer" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP006", assigned: true });
  });

  it("sendWelcomeEmail returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "sendWelcomeEmail",
      args: { employeeId: "EMP006" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP006", sent: true });
  });

  it("scheduleOrientation returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "scheduleOrientation",
      args: { employeeId: "EMP006", date: "2025-03-05" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP006", scheduled: true });
  });

  it("assignMentor returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "assignMentor",
      args: { employeeId: "EMP006", mentorId: "EMP003" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP006", mentorId: "EMP003" });
  });

  it("getOnboardingStatus returns status", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getOnboardingStatus",
      args: { employeeId: "EMP006" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP006" });
    expect(data).toHaveProperty("checklist");
  });
});

describe("recruiting tools", () => {
  const executor = createToolExecutor();

  it("createJobPosting returns new posting", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "createJobPosting",
      args: {
        title: "Senior Engineer",
        department: "Engineering",
        description: "Build stuff",
      },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("id");
    expect(data).toMatchObject({ title: "Senior Engineer", status: "open" });
  });

  it("listCandidates returns candidates", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "listCandidates",
      args: {},
    });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("scheduleInterview returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "scheduleInterview",
      args: {
        candidateId: "CAND-001",
        interviewerId: "EMP003",
        date: "2025-03-10",
        time: "14:00",
      },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ candidateId: "CAND-001", scheduled: true });
  });

  it("sendOffer returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "sendOffer",
      args: {
        candidateId: "CAND-001",
        salary: 120000,
        startDate: "2025-04-01",
      },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ candidateId: "CAND-001", status: "offered" });
  });

  it("rejectCandidate returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "rejectCandidate",
      args: { candidateId: "CAND-002", reason: "Not a fit" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({
      candidateId: "CAND-002",
      status: "rejected",
    });
  });

  it("getJobPostings returns postings", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getJobPostings",
      args: {},
    });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("getCandidateProfile returns profile", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getCandidateProfile",
      args: { candidateId: "CAND-001" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("id", "CAND-001");
    expect(data).toHaveProperty("name");
  });
});

describe("compliance tools", () => {
  const executor = createToolExecutor();

  it("runComplianceCheck returns results", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "runComplianceCheck",
      args: { employeeId: "EMP001" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("violations");
  });

  it("getAuditLog returns entries", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getAuditLog",
      args: {},
    });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("generateComplianceReport returns report", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "generateComplianceReport",
      args: { period: "Q1-2025" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ period: "Q1-2025" });
    expect(data).toHaveProperty("summary");
  });

  it("flagViolation returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "flagViolation",
      args: {
        violationType: "missing-i9",
        description: "Missing I-9 form",
      },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("violationId");
    expect(data).toMatchObject({ flagged: true });
  });

  it("getComplianceStatus returns status", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getComplianceStatus",
      args: {},
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("overallStatus");
  });
});

describe("benefits tools", () => {
  const executor = createToolExecutor();

  it("enrollBenefits returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "enrollBenefits",
      args: { employeeId: "EMP001", planIds: ["PLAN-DENTAL"] },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP001", enrolled: true });
  });

  it("getBenefitOptions returns plans", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getBenefitOptions",
      args: { employeeId: "EMP001" },
    });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("updateBenefitElection returns confirmation", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "updateBenefitElection",
      args: {
        employeeId: "EMP001",
        planId: "PLAN-HEALTH",
        changes: { coverage: "family" },
      },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ updated: true });
  });

  it("calculateBenefitCost returns cost breakdown", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "calculateBenefitCost",
      args: { employeeId: "EMP001", planId: "PLAN-HEALTH" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("employeeCost");
    expect(data).toHaveProperty("employerCost");
  });

  it("getEnrolledBenefits returns enrolled plans", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getEnrolledBenefits",
      args: { employeeId: "EMP001" },
    });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("reporting tools", () => {
  const executor = createToolExecutor();

  it("getHeadcount returns headcount", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getHeadcount",
      args: {},
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("total");
  });

  it("getHeadcount with groupBy returns breakdown", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getHeadcount",
      args: { groupBy: "department" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("total");
    expect(data).toHaveProperty("breakdown");
  });

  it("getAttrition returns rate", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getAttrition",
      args: { period: "Q1-2025" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("period", "Q1-2025");
    expect(data).toHaveProperty("rate");
  });

  it("generateReport returns report", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "generateReport",
      args: { reportType: "headcount", period: "Q1-2025" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("reportType", "headcount");
    expect(data).toHaveProperty("generatedAt");
  });

  it("exportData returns export info", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "exportData",
      args: { dataType: "employees", format: "csv" },
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("format", "csv");
    expect(data).toHaveProperty("downloadUrl");
  });

  it("getOrgChart returns hierarchy", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getOrgChart",
      args: {},
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("root");
  });

  it("getDiversityMetrics returns metrics", async () => {
    const result = await executor({
      type: "tool-call",
      toolCallId: "1",
      toolName: "getDiversityMetrics",
      args: {},
    });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("totalEmployees");
  });
});

// --- New tool handlers in existing categories ---

describe("employees (new tools)", () => {
  const executor = createToolExecutor();

  it("getEmployeeDocuments returns docs", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getEmployeeDocuments", args: { employeeId: "EMP001" } });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("uploadDocument returns confirmation", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "uploadDocument", args: { employeeId: "EMP001", documentName: "cert.pdf", category: "certifications", url: "/docs/cert.pdf" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ uploaded: true });
  });
});

describe("payroll (new tools)", () => {
  const executor = createToolExecutor();

  it("getPaystub returns paystub", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getPaystub", args: { employeeId: "EMP001", period: "2025-01" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ employeeId: "EMP001", period: "2025-01" });
    expect(data).toHaveProperty("gross");
  });

  it("calculateBonus returns bonus", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "calculateBonus", args: { employeeId: "EMP001", period: "2025" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("bonusAmount");
  });
});

describe("recruiting (new tools)", () => {
  const executor = createToolExecutor();

  it("getApplicationStatus returns status", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getApplicationStatus", args: { candidateId: "CAND-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ candidateId: "CAND-001", status: "interviewing" });
  });
});

describe("compliance (new tools)", () => {
  const executor = createToolExecutor();

  it("acknowledgePolicy returns confirmation", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "acknowledgePolicy", args: { employeeId: "EMP001", policyId: "POL-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ acknowledged: true });
  });
});

describe("benefits (new tools)", () => {
  const executor = createToolExecutor();

  it("compareBenefitPlans returns comparison", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "compareBenefitPlans", args: { planIds: ["PLAN-HEALTH", "PLAN-DENTAL"] } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("comparison");
  });

  it("getBenefitsCost returns total cost", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getBenefitsCost", args: { employeeId: "EMP001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("totalEmployeeCost");
  });
});

describe("timeoff (new tools)", () => {
  const executor = createToolExecutor();

  it("getHolidayCalendar returns holidays", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getHolidayCalendar", args: { year: 2025 } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ year: 2025 });
    expect(data).toHaveProperty("holidays");
  });
});

describe("onboarding (new tools)", () => {
  const executor = createToolExecutor();

  it("getOnboardingChecklist returns checklist", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getOnboardingChecklist", args: { role: "Engineer" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ role: "Engineer" });
    expect(data).toHaveProperty("tasks");
  });

  it("completeOnboardingTask returns confirmation", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "completeOnboardingTask", args: { employeeId: "EMP001", taskId: "OT-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ completed: true });
  });
});

describe("reporting (new tools)", () => {
  const executor = createToolExecutor();

  it("getCustomDashboard returns widgets", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getCustomDashboard", args: { dashboardId: "DASH-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("widgets");
  });

  it("scheduleReport returns confirmation", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "scheduleReport", args: { reportType: "headcount", frequency: "monthly", recipients: ["hr@co.com"] } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ created: true });
  });
});

// --- New enterprise categories ---

describe("finance tools", () => {
  const executor = createToolExecutor();

  it("createInvoice returns new invoice", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "createInvoice", args: { clientId: "CLI-001", lineItems: [{ description: "Service", amount: 1000, quantity: 2 }], dueDate: "2025-03-15" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("id");
    expect(data).toHaveProperty("total", 2000);
  });

  it("getInvoice returns invoice", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getInvoice", args: { invoiceId: "INV-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ id: "INV-001" });
  });

  it("listInvoices returns filtered results", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "listInvoices", args: { status: "paid" } });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("generateFinancialReport returns report", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "generateFinancialReport", args: { reportType: "profit-loss", period: "Q1-2025" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ reportType: "profit-loss" });
  });

  it("getBudget returns budget info", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getBudget", args: {} });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("allocated");
    expect(data).toHaveProperty("remaining");
  });
});

describe("it tools", () => {
  const executor = createToolExecutor();

  it("createTicket returns new ticket", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "createTicket", args: { title: "VPN issue", description: "Cannot connect", requesterId: "EMP001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("id");
    expect(data).toMatchObject({ status: "open" });
  });

  it("getTicket returns ticket", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getTicket", args: { ticketId: "TKT-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ id: "TKT-001" });
  });

  it("listAssets returns assets", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "listAssets", args: {} });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("revokeSystemAccess returns confirmation", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "revokeSystemAccess", args: { employeeId: "EMP001", systemName: "Jira", reason: "Offboarding" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ revoked: true });
  });
});

describe("crm tools", () => {
  const executor = createToolExecutor();

  it("createContact returns new contact", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "createContact", args: { name: "Test User", email: "test@co.com" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("id");
    expect(data).toMatchObject({ status: "lead" });
  });

  it("getContact returns contact", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getContact", args: { contactId: "CON-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ id: "CON-001" });
  });

  it("getPipeline returns stages", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getPipeline", args: {} });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("stages");
    expect(data).toHaveProperty("totalValue");
  });

  it("generateSalesReport returns report", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "generateSalesReport", args: { period: "Q1-2025" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("data");
  });
});

describe("projects tools", () => {
  const executor = createToolExecutor();

  it("getProject returns project", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getProject", args: { projectId: "PROJ-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ id: "PROJ-001", status: "active" });
  });

  it("listTasks returns tasks", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "listTasks", args: { projectId: "PROJ-001" } });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("getProjectBudget returns budget", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getProjectBudget", args: { projectId: "PROJ-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("totalBudget");
    expect(data).toHaveProperty("spent");
  });
});

describe("procurement tools", () => {
  const executor = createToolExecutor();

  it("getVendor returns vendor", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getVendor", args: { vendorId: "VND-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ id: "VND-001" });
  });

  it("getProcurementContract returns contract", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getProcurementContract", args: { contractId: "PC-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ id: "PC-001", status: "active" });
  });

  it("getInventoryLevel returns stock info", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getInventoryLevel", args: {} });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("currentStock");
  });
});

describe("training tools", () => {
  const executor = createToolExecutor();

  it("getCourse returns course", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getCourse", args: { courseId: "CRS-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ id: "CRS-001" });
  });

  it("enrollInCourse returns enrollment", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "enrollInCourse", args: { employeeId: "EMP001", courseId: "CRS-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ status: "enrolled" });
  });

  it("getTrainingReport returns report", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getTrainingReport", args: { period: "Q1-2025" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("data");
  });
});

describe("performance tools", () => {
  const executor = createToolExecutor();

  it("getReview returns review", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getReview", args: { reviewId: "REV-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ id: "REV-001" });
  });

  it("getGoals returns goals", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getGoals", args: { employeeId: "EMP001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("goals");
  });

  it("getOKRs returns okrs", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getOKRs", args: {} });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("okrs");
  });
});

describe("facilities tools", () => {
  const executor = createToolExecutor();

  it("bookRoom returns confirmation", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "bookRoom", args: { roomId: "RM-001", date: "2025-03-01", startTime: "10:00", endTime: "11:00", organizerId: "EMP001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ booked: true });
  });

  it("listRooms returns rooms", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "listRooms", args: {} });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("getRoomSchedule returns schedule", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getRoomSchedule", args: { roomId: "RM-001", date: "2025-03-01" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("bookings");
  });
});

describe("legal tools", () => {
  const executor = createToolExecutor();

  it("getLegalContract returns contract", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getLegalContract", args: { contractId: "LC-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ id: "LC-001" });
  });

  it("createNDA returns new NDA", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "createNDA", args: { parties: ["Company", "TechCorp"], scope: "Product roadmap", duration: "2 years", effectiveDate: "2025-03-01" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("id");
    expect(data).toMatchObject({ status: "draft" });
  });

  it("listPolicies returns policies", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "listPolicies", args: {} });
    const data = result.result as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("communications tools", () => {
  const executor = createToolExecutor();

  it("sendAnnouncement returns confirmation", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "sendAnnouncement", args: { title: "Test", content: "Hello", senderId: "EMP005" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toMatchObject({ sent: true });
  });

  it("createSurvey returns new survey", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "createSurvey", args: { title: "Satisfaction", description: "Q1 survey", questions: [{ text: "Rate us", type: "rating" }] } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("id");
  });

  it("getSurveyResults returns results", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "getSurveyResults", args: { surveyId: "SRV-001" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("totalResponses");
  });

  it("generateCommunicationsReport returns report", async () => {
    const result = await executor({ type: "tool-call", toolCallId: "1", toolName: "generateCommunicationsReport", args: { period: "Q1-2025" } });
    const data = result.result as Record<string, unknown>;
    expect(data).toHaveProperty("data");
  });
});

describe("MOCK_DATA", () => {
  it("exports consistent employee data", () => {
    expect(MOCK_DATA.employees).toBeDefined();
    const marco = MOCK_DATA.employees.find(
      (e: Record<string, unknown>) => e.name === "Marco Rossi",
    );
    expect(marco).toBeDefined();
    expect(marco.id).toBe("EMP001");
  });

  it("exports consistent candidate data", () => {
    expect(MOCK_DATA.candidates).toBeDefined();
    const john = MOCK_DATA.candidates.find(
      (c: Record<string, unknown>) => c.name === "John Smith",
    );
    expect(john).toBeDefined();
  });
});
