import type { Scenario } from "../lib/types.js";

export const multiTurnScenarios: Scenario[] = [
  {
    id: 16,
    query: "Onboard Hendrik Honrik as a Software Engineer (department Engineering) starting 2030-04-04, with the following email hendrik@example.com, the manager is Marco Rossi",
    expectedTools: [
      ["searchEmployees", "getEmployee"],
      "createEmployee",
      "startOnboarding",
      "assignRole",
      "sendWelcomeEmail",
      "enrollBenefits",
      "scheduleOrientation",
    ],
    type: "multi-turn",
    seed: 3001,
    expectedOutcome:
      "Onboarding workflow must: create employee record, start onboarding process, assign engineer role, send welcome email, enroll in benefits, schedule orientation. Score based on fraction of steps completed via tool calls.",
    followUps: [
      "Now assign him the role 'engineer' and send the welcome email",
      "Enroll him in the benefit 'ABC' and schedule a remote orientation on the same hiring day",
    ],
  },
  {
    id: 17,
    query: "I need to process January 2025 payroll. List all active employees and calculate their payroll.",
    expectedTools: [
      "listEmployees",
      "calculatePayroll",
      "processPayroll",
      "generatePayslips",
    ],
    type: "multi-turn",
    seed: 3002,
    expectedOutcome:
      "Payroll workflow must: list employees, calculate payroll for January 2025, process the payroll, generate payslips. Score based on fraction of steps completed.",
    followUps: [
      "Great, now process the payroll and generate payslips for all of them",
    ],
  },
  {
    id: 18,
    query: "Prepare the quarterly comprehensive (whole company, all the metrics) HR report for Q1 2026, broken down by department. Include employee lists.",
    expectedTools: [
      "getHeadcount",
      "getAttrition",
      "listEmployees",
      "generateReport",
    ],
    type: "multi-turn",
    seed: 3003,
    expectedOutcome:
      "HR report workflow must: get headcount data, get attrition data, list employees, generate a formal report. Score based on fraction of steps completed.",
    followUps: [
      "Now compile everything into a formal report",
    ],
  },
  {
    id: 19,
    query: "Complete offboarding for departing employee Marco Rossi, effective date 2030-01-01, revoking his access from ALL the systems and calculating the final pay",
    expectedTools: [
      ["searchEmployees", "getEmployee"],
      "revokeAccess",
      "calculateFinalPay",
      "processPayroll",
      "archiveEmployee",
    ],
    type: "multi-turn",
    seed: 3004,
    expectedOutcome:
      "Offboarding workflow for Marco Rossi (EMP001) must: look up employee, revoke system access, calculate final pay, process final payroll, archive employee record. Score based on fraction of steps completed.",
    followUps: [
      "Now process the final payroll and archive his record",
    ],
  },
  {
    id: 20,
    query: "We're hiring the candidate John Smith after successful interview. Send him the offer with a 105,00 base salary, standard benefits and starting date 2027-01-01",
    expectedTools: [
      "listCandidates",
      "sendOffer",
      "createEmployee",
      "startOnboarding",
      ["searchEmployees", "getEmployee"],
    ],
    type: "multi-turn",
    seed: 3005,
    expectedOutcome:
      "Hiring workflow for John Smith (CAND-001) must: look up candidate, send offer, create employee record, start onboarding. Score based on fraction of steps completed.",
    followUps: [
      "He accepted! Now create his employee record (Software Engineer, john.smith@agentified.dev, Engineering department, and his manager is Marco Rossi)",
      "Perfect! Now start his onboarding"
    ],
  },
];
