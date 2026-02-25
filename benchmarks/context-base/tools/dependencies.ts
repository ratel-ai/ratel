/**
 * Tool dependency graph for HR-critical categories.
 *
 * `provides` = parameters this tool's output makes available (e.g. employeeId)
 * `requires` = parameters this tool needs that must come from another tool
 *
 * Used by server-side graph expansion to inject prerequisite tools
 * when semantic search finds a tool but misses its dependency chain.
 */

export type ToolDependencyEntry = {
  provides?: string[];
  requires?: string[];
};

export const TOOL_DEPENDENCIES: Record<string, ToolDependencyEntry> = {
  // ── Employees ──────────────────────────────────────────────
  searchEmployees: { provides: ["employeeId"] },
  updateEmployee: { requires: ["employeeId"] },
  deleteEmployee: { requires: ["employeeId"] },
  getEmployeeHistory: { requires: ["employeeId"] },
  revokeAccess: { requires: ["employeeId"] },
  archiveEmployee: { requires: ["employeeId"] },
  getEmployeeDocuments: { requires: ["employeeId"] },
  uploadDocument: { requires: ["employeeId"] },

  // ── Payroll ────────────────────────────────────────────────
  getSalary: { requires: ["employeeId"] },
  updateSalary: { requires: ["employeeId"] },
  calculateFinalPay: { requires: ["employeeId"] },
  getSalaryHistory: { requires: ["employeeId"] },
  getPaystub: { requires: ["employeeId"] },
  calculateBonus: { requires: ["employeeId"] },

  // ── Benefits ───────────────────────────────────────────────
  enrollBenefits: { requires: ["employeeId"] },
  getBenefitOptions: { requires: ["employeeId"] },
  updateBenefitElection: { requires: ["employeeId"] },
  calculateBenefitCost: { requires: ["employeeId"] },
  getEnrolledBenefits: { requires: ["employeeId"] },
  getBenefitsCost: { requires: ["employeeId"] },

  // ── Time Off ───────────────────────────────────────────────
  getTimeOffBalance: { requires: ["employeeId"] },
  requestTimeOff: { requires: ["employeeId"] },
  getTimeOffHistory: { requires: ["employeeId"] },

  // ── Onboarding ─────────────────────────────────────────────
  startOnboarding: { requires: ["employeeId"] },
  assignRole: { requires: ["employeeId"] },
  sendWelcomeEmail: { requires: ["employeeId"] },
  scheduleOrientation: { requires: ["employeeId"] },
  assignMentor: { requires: ["employeeId"] },
  getOnboardingStatus: { requires: ["employeeId"] },
  completeOnboardingTask: { requires: ["employeeId"] },

  // ── Recruiting ─────────────────────────────────────────────
  listCandidates: { provides: ["candidateId"] },
  getCandidateProfile: { requires: ["candidateId"] },
  getApplicationStatus: { requires: ["candidateId"] },
  scheduleInterview: { requires: ["candidateId"] },
  sendOffer: { requires: ["candidateId"] },
  rejectCandidate: { requires: ["candidateId"] },

  // ── Performance ────────────────────────────────────────────
  getReview: { requires: ["reviewId"] },
  listReviews: { provides: ["reviewId"] },
  submitSelfAssessment: { requires: ["reviewId", "employeeId"] },
  submitPeerFeedback: { requires: ["reviewId"] },
  setGoals: { requires: ["employeeId"] },
  getGoals: { requires: ["employeeId"] },
  createOKR: { requires: ["employeeId"] },
  requestFeedback: { requires: ["employeeId"] },

  // ── Training ───────────────────────────────────────────────
  getCourse: { requires: ["courseId"] },
  listCourses: { provides: ["courseId"] },
  enrollInCourse: { requires: ["employeeId", "courseId"] },
  getCourseProgress: { requires: ["employeeId", "courseId"] },
  completeCourse: { requires: ["employeeId", "courseId"] },
  listCourseEnrollments: {},
  renewCertification: { requires: ["employeeId"] },
  submitAssessment: { requires: ["employeeId"] },
};
