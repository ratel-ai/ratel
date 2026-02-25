import type { Scenario } from "../lib/types.js";

export const scaleStressScenarios: Scenario[] = [
  {
    id: 36,
    query: "What courses and certifications has Marco completed this year?",
    expectedTools: [["searchEmployees", "getEmployee"], "listCourseEnrollments", "listCertifications"],
    type: "retrieval",
    category: "scale-stress",
    seed: 6011,
    expectedOutcome:
      "Marco (EMP001) has completed Security Awareness (CRS-001, score 92) and certification: AWS Solutions Architect (active, expires 2026-03-01). Must use listCourseEnrollments for course data and listCertifications for certifications.",
  },
  {
    id: 37,
    query: "Create an NDA between Acme Corp and TechCorp for the new partnership, covering shared product roadmap and financials, lasting 2 years, effective 2025-03-01",
    expectedTools: ["createNDA"],
    type: "retrieval",
    category: "scale-stress",
    seed: 6012,
    expectedParams: {
      createNDA: { parties: ["Acme Corp", "TechCorp"], scope: "shared product roadmap and financials", duration: "2 years", effectiveDate: "2025-03-01" },
    },
    expectedOutcome:
      "Must call createNDA with Acme Corp and TechCorp as parties, appropriate scope, 2-year duration, effective 2025-03-01. An existing NDA (NDA-001) with TechCorp already exists. Answer should confirm new NDA creation.",
  },
  {
    id: 38,
    query: "Show me the employee satisfaction survey results",
    expectedTools: ["listSurveys", "getSurveyResults"],
    type: "retrieval",
    category: "scale-stress",
    seed: 6013,
    expectedOutcome:
      "Employee Satisfaction Q1 survey (SRV-001): active, 42 responses, deadline 2025-03-31. Must call getSurveyResults and present actual results.",
  },
  {
    id: 39,
    query: "What's the room availability for the 3rd floor conference rooms tomorrow?",
    expectedTools: ["listRooms", "getRoomSchedule"],
    type: "retrieval",
    category: "scale-stress",
    seed: 6014,
    expectedOutcome:
      "Floor 3 has one room: Everest (RM-001, capacity 10, projector+whiteboard). Must call listRooms and getRoomSchedule. Answer must include room availability details.",
  },
  {
    id: 40,
    query: "Show me Marco's performance goals and OKR progress",
    expectedTools: [["searchEmployees", "getEmployee"], "getGoals", "getOKRs"],
    type: "retrieval",
    category: "scale-stress",
    seed: 6015,
    expectedOutcome:
      "Must call getGoals and getOKRs for Marco (EMP001). Answer must include both performance goals and OKR progress data.",
  },
];
