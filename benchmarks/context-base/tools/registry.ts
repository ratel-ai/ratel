import type { ToolSet } from "ai";
import { employeeTools } from "./categories/employees.js";
import { payrollTools } from "./categories/payroll.js";
import { timeoffTools } from "./categories/timeoff.js";
import { onboardingTools } from "./categories/onboarding.js";
import { recruitingTools } from "./categories/recruiting.js";
import { complianceTools } from "./categories/compliance.js";
import { benefitsTools } from "./categories/benefits.js";
import { reportingTools } from "./categories/reporting.js";
import { financeTools } from "./categories/finance.js";
import { itTools } from "./categories/it.js";
import { crmTools } from "./categories/crm.js";
import { projectsTools } from "./categories/projects.js";
import { procurementTools } from "./categories/procurement.js";
import { trainingTools } from "./categories/training.js";
import { performanceTools } from "./categories/performance.js";
import { facilitiesTools } from "./categories/facilities.js";
import { legalTools } from "./categories/legal.js";
import { communicationsTools } from "./categories/communications.js";

export const TOOL_CATEGORIES: Record<string, string[]> = {
  employees: Object.keys(employeeTools),
  payroll: Object.keys(payrollTools),
  timeoff: Object.keys(timeoffTools),
  onboarding: Object.keys(onboardingTools),
  recruiting: Object.keys(recruitingTools),
  compliance: Object.keys(complianceTools),
  benefits: Object.keys(benefitsTools),
  reporting: Object.keys(reportingTools),
  finance: Object.keys(financeTools),
  it: Object.keys(itTools),
  crm: Object.keys(crmTools),
  projects: Object.keys(projectsTools),
  procurement: Object.keys(procurementTools),
  training: Object.keys(trainingTools),
  performance: Object.keys(performanceTools),
  facilities: Object.keys(facilitiesTools),
  legal: Object.keys(legalTools),
  communications: Object.keys(communicationsTools),
};

export const toolRegistry: ToolSet = {
  ...employeeTools,
  ...payrollTools,
  ...timeoffTools,
  ...onboardingTools,
  ...recruitingTools,
  ...complianceTools,
  ...benefitsTools,
  ...reportingTools,
  ...financeTools,
  ...itTools,
  ...crmTools,
  ...projectsTools,
  ...procurementTools,
  ...trainingTools,
  ...performanceTools,
  ...facilitiesTools,
  ...legalTools,
  ...communicationsTools,
};
