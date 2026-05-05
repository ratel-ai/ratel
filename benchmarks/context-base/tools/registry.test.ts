import { describe, it, expect } from "vitest";
import { toolRegistry, TOOL_CATEGORIES } from "./registry.js";

describe("toolRegistry", () => {
  it("exports a ToolSet with 200+ tools", () => {
    const toolNames = Object.keys(toolRegistry);
    expect(toolNames.length).toBeGreaterThanOrEqual(200);
  });

  it("every tool has a description and inputSchema", () => {
    for (const [name, t] of Object.entries(toolRegistry)) {
      expect(t.description, `${name} missing description`).toBeTruthy();
      expect(t.inputSchema, `${name} missing inputSchema`).toBeDefined();
    }
  });

  it("contains all 18 expected tool categories", () => {
    const expectedCategories = [
      "employees",
      "payroll",
      "timeoff",
      "onboarding",
      "recruiting",
      "compliance",
      "benefits",
      "reporting",
      "finance",
      "it",
      "crm",
      "projects",
      "procurement",
      "training",
      "performance",
      "facilities",
      "legal",
      "communications",
    ];
    expect(Object.keys(TOOL_CATEGORIES).sort()).toEqual(
      expectedCategories.sort(),
    );
  });

  it("each category maps to tool names that exist in registry", () => {
    for (const [category, names] of Object.entries(TOOL_CATEGORIES)) {
      expect(names.length, `${category} has no tools`).toBeGreaterThan(0);
      for (const name of names) {
        expect(toolRegistry[name], `${name} from ${category} not in registry`).toBeDefined();
      }
    }
  });

  it("includes all PRD-specified tools", () => {
    const prdTools = [
      // Employees
      "getEmployee", "listEmployees", "createEmployee", "updateEmployee", "deleteEmployee",
      // Payroll
      "getSalary", "updateSalary", "calculatePayroll", "processPayroll", "generatePayslips",
      // Time-Off
      "getTimeOffBalance", "requestTimeOff", "approveTimeOff", "getPendingTimeOff", "getTimeOffHistory",
      // Onboarding
      "startOnboarding", "assignRole", "sendWelcomeEmail", "scheduleOrientation", "assignMentor",
      // Recruiting
      "createJobPosting", "listCandidates", "scheduleInterview", "sendOffer", "rejectCandidate",
      // Compliance
      "runComplianceCheck", "getAuditLog", "generateComplianceReport", "flagViolation",
      // Benefits
      "enrollBenefits", "getBenefitOptions", "updateBenefitElection", "calculateBenefitCost",
      // Reporting
      "getHeadcount", "getAttrition", "generateReport", "exportData", "getOrgChart",
      // Multi-turn scenario tools
      "revokeAccess", "calculateFinalPay", "archiveEmployee",
    ];
    for (const name of prdTools) {
      expect(toolRegistry[name], `PRD tool ${name} missing`).toBeDefined();
    }
  });

  it("no tool appears in multiple categories", () => {
    const seen = new Map<string, string>();
    for (const [category, names] of Object.entries(TOOL_CATEGORIES)) {
      for (const name of names) {
        expect(
          seen.has(name),
          `${name} in both ${seen.get(name)} and ${category}`,
        ).toBe(false);
        seen.set(name, category);
      }
    }
  });

  it("all registry tools belong to a category", () => {
    const categorized = new Set(
      Object.values(TOOL_CATEGORIES).flat(),
    );
    for (const name of Object.keys(toolRegistry)) {
      expect(categorized.has(name), `${name} not in any category`).toBe(true);
    }
  });
});
