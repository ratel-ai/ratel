import type { Scenario } from "../lib/types.js";

export const retrievalScenarios: Scenario[] = [
  {
    id: 1,
    query: "What's Marco Rossi's salary?",
    expectedTools: [["getEmployee", "searchEmployees"], "getSalary"],
    type: "retrieval",
    seed: 1001,
    expectedOutcome:
      "Marco Rossi (EMP001) has base salary 95,000 USD and bonus 10,000 USD, total 105,000 USD. Answer must contain the base or total (or both) to be correct.",
  },
  {
    id: 2,
    query: "How many vacation days does Lisa have?",
    expectedTools: ["searchEmployees", "getTimeOffBalance"],
    type: "retrieval",
    seed: 1002,
    expectedOutcome:
      "Lisa Chen (EMP002) has 12 vacation days, 10 sick days, 3 personal days. Answer must mention 12 vacation days, and must not ask about confirmation before proceeding.",
  },
  {
    id: 3,
    query: "Show me the org chart",
    expectedTools: ["getOrgChart"],
    type: "retrieval",
    seed: 1003,
    expectedOutcome:
      "Org chart: Emily Davis (CTO) at top. Sarah Chen, James Wilson, Alex Kim, Maria Garcia report to Emily. Marco Rossi and Lisa Chen report to Sarah Chen. Answer must show the hierarchy, and must not ask for confirmation before proceeding.",
  },
  {
    id: 4,
    query: "List all pending time-off requests including name and IDs of the employees",
    expectedTools: [["getEmployee", "searchEmployees"], "getPendingTimeOff"],
    type: "retrieval",
    seed: 1004,
    expectedOutcome:
      "3 pending requests: Lisa Chen (PTO-001, vacation Jun 1-5), Marco Rossi (PTO-002, personal Apr 10), Alex Kim (PTO-003, vacation Jul 1-10). Answer must list all three.",
  },
  {
    id: 5,
    query: "What benefits is Marco enrolled in?",
    expectedTools: ["searchEmployees", "getEnrolledBenefits"],
    type: "retrieval",
    seed: 1005,
    expectedOutcome:
      "Marco (EMP001) is enrolled in Health Insurance PPO (PLAN-HEALTH) and 401(k) Retirement (PLAN-401K). Answer must mention both.",
  },
  {
    id: 6,
    query: "Show headcount by department",
    expectedTools: ["getHeadcount"],
    type: "retrieval",
    seed: 1006,
    expectedOutcome:
      "Headcount: Engineering 3, HR 1, Executive 1, Marketing 1, Finance 1. Total 7. Answer must show breakdown by department.",
  },
  {
    id: 7,
    query: "What's the average salary in Engineering?",
    expectedTools: [["listEmployees", "searchEmployees"], "getSalary"],
    type: "retrieval",
    seed: 1007,
    expectedOutcome:
      "Engineering employees: Marco (95k base), Lisa (85k base), Sarah (130k base). Average base salary = 103,333. Answer must contain a correct average.",
  },
  {
    id: 8,
    query: "Who reports to Sarah Chen?",
    expectedTools: [["getEmployee", "searchEmployees"], "getOrgChart"],
    type: "retrieval",
    seed: 1008,
    expectedOutcome:
      "Sarah Chen (EMP003) manages Marco Rossi (EMP001) and Lisa Chen (EMP002). Answer must list both direct reports.",
  },
];
