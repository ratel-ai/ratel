import type { Scenario } from "../lib/types.js";

export const distractorResistanceScenarios: Scenario[] = [
  {
    id: 31,
    query: "Get the vendor contract renewal status for CloudTech",
    expectedTools: [["getProcurementContract", "listProcurementContracts"], ["getVendor", "listVendors"]],
    type: "retrieval",
    category: "distractor",
    seed: 6006,
    expectedOutcome:
      "CloudTech procurement contract (PC-001): Cloud Hosting, active, until Dec 2025. Must call getProcurementContract or listProcurementContracts, NOT getLegalContract.",
  },
  {
    id: 32,
    query: "Generate the quarterly compliance report for Q1 2025",
    expectedTools: ["generateComplianceReport"],
    type: "retrieval",
    category: "distractor",
    seed: 6007,
    expectedParams: {
      generateComplianceReport: { period: "Q1-2025" },
    },
    expectedOutcome:
      "Must call generateComplianceReport for Q1-2025. Answer should contain a compliance report or confirmation of generation.",
  },
  {
    id: 33,
    query: "Revoke Marco's system access to Jira due to offboarding",
    expectedTools: [["searchEmployees", "getEmployee"], "revokeSystemAccess"],
    type: "retrieval",
    category: "distractor",
    seed: 6008,
    expectedParams: {
      revokeSystemAccess: { employeeId: "EMP001", systemName: "Jira" },
    },
    expectedOutcome:
      "Must call revokeSystemAccess for Marco Rossi (EMP001) targeting Jira specifically. revokeAccess revokes ALL systems which is overkill for a single-system revocation.",
  },
  {
    id: 34,
    query: "What's the legal contract status for the CloudTech SLA?",
    expectedTools: ["listLegalContracts"],
    type: "retrieval",
    category: "distractor",
    seed: 6009,
    expectedParams: { listLegalContracts: {} },
    expectedOutcome:
      "CloudTech SLA legal contract (LC-001): service type, active, Jan 2024 - Dec 2025, parties Company and CloudTech Solutions, value 120,000. Must call listLegalContracts (or getLegalContract if ID is known), NOT getProcurementContract.",
  },
  {
    id: 35,
    query: "Assign the task about implementing the API to Lisa Chen in the Platform Redesign project",
    expectedTools: [["searchEmployees", "getEmployee"], "listTasks", "assignTask"],
    type: "retrieval",
    category: "distractor",
    seed: 6010,
    expectedParams: {
      assignTask: { taskId: "TASK-002", assigneeId: "EMP002" },
    },
    expectedOutcome:
      "Must list tasks in Platform Redesign (PROJ-001) to find TASK-002 (Implement API), then call assignTask to assign it to Lisa Chen (EMP002). NOT createTask.",
  },
];
