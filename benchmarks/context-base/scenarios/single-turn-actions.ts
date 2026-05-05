import type { Scenario } from "../lib/types.js";

export const actionScenarios: Scenario[] = [
  {
    id: 9,
    query: "Change Marco's email to marco@newdomain.com",
    expectedTools: [["searchEmployees", "getEmployee"], "updateEmployee"],
    type: "action",
    seed: 2001,
    expectedParams: {
      updateEmployee: { employeeId: "EMP001", email: "marco@newdomain.com" },
    },
  },
  {
    id: 10,
    query: "Approve Lisa's time-off request (current user ID: EMP001)",
    expectedTools: [["searchEmployees", "getEmployee"], "getPendingTimeOff", "approveTimeOff"],
    type: "action",
    seed: 2002,
    expectedParams: {
      approveTimeOff: { requestId: "PTO-001", approverId: "EMP001" },
    },
  },
  {
    id: 11,
    query: "Give Marco Rossi a 10% raise starting 2030-01-01, he's been the employee selling the most",
    expectedTools: [["searchEmployees", "getEmployee"], "getSalary", "updateSalary"],
    type: "action",
    seed: 2003,
    expectedParams: {
      updateSalary: { employeeId: "EMP001", baseSalary: 104500, effectiveDate: "2030-01-01" },
    },
  },
  {
    id: 12,
    query: "Create a job posting for a 'Senior Product Engineer', invent the job offer details without asking me for confirmation",
    expectedTools: ["createJobPosting"],
    type: "action",
    seed: 2004,
    expectedParams: {
      createJobPosting: { title: "Senior Product Engineer" },
    },
  },
  {
    id: 13,
    query: "Schedule a video interview with Marco for the candidate John Smith on 2030-01-02 at 10:10 CET",
    expectedTools: [["searchEmployees", "getEmployee"], "listCandidates", "scheduleInterview"],
    type: "action",
    seed: 2005,
    expectedParams: {
      scheduleInterview: { candidateId: "CAND-001", interviewerId: "EMP001", date: "2030-01-02", time: "10:10", timezone: "CET", type: "video" },
    },
  },
  {
    id: 14,
    query: "Enroll Lisa in dental benefits starting 2031-02-03",
    expectedTools: [["searchEmployees", "getEmployee"], "getBenefitOptions", "enrollBenefits"],
    type: "action",
    seed: 2006,
    expectedParams: {
      enrollBenefits: { employeeId: "EMP002", planIds: ["PLAN-DENTAL"], effectiveDate: "2031-02-03" },
    },
  },
  {
    id: 15,
    query: "Flag compliance violation for missing I-9, severity: high (current user EMP002)",
    expectedTools: ["flagViolation"],
    type: "action",
    seed: 2007,
    expectedParams: {
      flagViolation: { violationType: "i9", employeeId: "EMP002", severity: "high" },
    },
  },
];
