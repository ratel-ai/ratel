import type { Scenario } from "../lib/types.js";

export const crossDomainScenarios: Scenario[] = [
  {
    id: 26,
    query: "What laptops do we have right now? And what's the status of the purchase order for new laptops?",
    expectedTools: ["listPurchaseOrders", ["getEmployee", "searchEmployees"], "listAssets"],
    type: "retrieval",
    category: "cross-domain",
    seed: 6001,
    expectedOutcome:
      "No purchase orders for laptops exist in the system. Assets show one MacBook Pro 16 (AST-001) assigned to Marco Rossi (EMP001). Answer must reflect actual data.",
  },
  {
    id: 27,
    query: "Find and book any meeting room for 60 minutes and schedule a video interview with candidate John Smith interviewed by Sarah Chen for next Tuesday 2025-03-04 at 1pm CET",
    expectedTools: ["listCandidates", ["searchEmployees", "getEmployee"], "listRooms", "getRoomSchedule", "bookRoom", "scheduleInterview"],
    type: "action",
    category: "cross-domain",
    seed: 6002,
    expectedOutcome:
      "Agent must book a room (Everest or Alpine) AND schedule the interview for CAND-001 with interviewer EMP003 on 2025-03-04 at 13:00. Both actions must be completed.",
  },
  {
    id: 28,
    query: "What training courses has Marco completed in 2025 and what certifications does he hold?",
    expectedTools: [["searchEmployees", "getEmployee"], "listCourseEnrollments", "listCertifications"],
    type: "retrieval",
    category: "cross-domain",
    seed: 6003,
    expectedOutcome:
      "Marco (EMP001) completed Security Awareness (CRS-001, score 92). He holds one certification: AWS Solutions Architect (CERT-001, active, expires 2026-03-01). Answer must include both enrollment and certification details (IDs are optional).",
  },
  {
    id: 29,
    query: "Show me the Platform Redesign project budget and the department budget for Engineering in 2025",
    expectedTools: ["listProjects", "getProjectBudget", "getBudget"],
    type: "retrieval",
    category: "cross-domain",
    seed: 6004,
    expectedOutcome:
      "Platform Redesign project (PROJ-001) has budget 500,000. Department budget for Engineering is 500,000 too. Answer must include both budget figures.",
  },
  {
    id: 30,
    query: "Who are the vendors for IT equipment and what are their contract renewal dates?",
    expectedTools: ["listVendors", "listProcurementContracts"],
    type: "retrieval",
    category: "cross-domain",
    seed: 6005,
    expectedOutcome:
      "One IT vendor: CloudTech Solutions (VND-002, active, rating 4.5). One procurement contract: Cloud Hosting (PC-001, active, Jan 2024 - Dec 2025, value 120,000). Answer must include vendor and contract renewal date.",
  },
];
