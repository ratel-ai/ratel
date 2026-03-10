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
  getEmployee: { provides: ["employeeId"] },
  listEmployees: { provides: ["employeeId"] },
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
  getPendingTimeOff: { provides: ["requestId"] },
  approveTimeOff: { requires: ["requestId"] },
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
  getOKRs: { requires: ["employeeId"] },
  createOKR: { requires: ["employeeId"] },
  requestFeedback: { requires: ["employeeId"] },

  // ── Training ───────────────────────────────────────────────
  getCourse: { requires: ["courseId"] },
  listCourses: { provides: ["courseId"] },
  enrollInCourse: { requires: ["employeeId", "courseId"] },
  getCourseProgress: { requires: ["employeeId", "courseId"] },
  completeCourse: { requires: ["employeeId", "courseId"] },
  listCourseEnrollments: { requires: ["employeeId"] },
  renewCertification: { requires: ["employeeId"] },
  submitAssessment: { requires: ["employeeId"] },

  // ── CRM ───────────────────────────────────────────────────
  listContacts: { provides: ["contactId"] },
  getContact: { requires: ["contactId"] },
  updateContact: { requires: ["contactId"] },
  getContactHistory: { requires: ["contactId"] },
  listDeals: { provides: ["dealId"] },
  getDeal: { requires: ["dealId"] },
  updateDeal: { requires: ["dealId"] },
  createQuote: { requires: ["dealId"], provides: ["quoteId"] },
  getQuote: { requires: ["quoteId"] },
  sendQuote: { requires: ["quoteId"] },

  // ── IT ────────────────────────────────────────────────────
  listTickets: { provides: ["ticketId"] },
  getTicket: { requires: ["ticketId"] },
  updateTicket: { requires: ["ticketId"] },
  assignTicket: { requires: ["ticketId"] },
  resolveTicket: { requires: ["ticketId"] },
  listAssets: { provides: ["assetId"] },
  getAsset: { requires: ["assetId"] },
  assignAsset: { requires: ["assetId"] },
  retireAsset: { requires: ["assetId"] },
  listSoftwareLicenses: { provides: ["licenseId"] },
  getSoftwareLicense: { requires: ["licenseId"] },

  // ── Projects ──────────────────────────────────────────────
  listProjects: { provides: ["projectId"] },
  getProject: { requires: ["projectId"] },
  updateProject: { requires: ["projectId"] },
  getProjectBudget: { requires: ["projectId"] },
  getMilestones: { requires: ["projectId"], provides: ["milestoneId"] },
  updateMilestone: { requires: ["milestoneId"] },
  listTasks: { provides: ["taskId"] },
  getTask: { requires: ["taskId"] },
  updateTask: { requires: ["taskId"] },
  assignTask: { requires: ["taskId"] },

  // ── Finance ───────────────────────────────────────────────
  listInvoices: { provides: ["invoiceId"] },
  getInvoice: { requires: ["invoiceId"] },
  approveInvoice: { requires: ["invoiceId"] },
  listExpenseReports: { provides: ["expenseReportId"] },
  getExpenseReport: { requires: ["expenseReportId"] },
  approveExpense: { requires: ["expenseReportId"] },

  // ── Procurement ───────────────────────────────────────────
  listVendors: { provides: ["vendorId"] },
  getVendor: { requires: ["vendorId"] },
  updateVendor: { requires: ["vendorId"] },
  rateVendor: { requires: ["vendorId"] },
  listPurchaseOrders: { provides: ["poId"] },
  getPurchaseOrder: { requires: ["poId"] },
  approvePurchaseOrder: { requires: ["poId"] },
  listProcurementContracts: { provides: ["procurementContractId"] },
  getProcurementContract: { requires: ["procurementContractId"] },
  renewContract: { requires: ["procurementContractId"] },

  // ── Legal ─────────────────────────────────────────────────
  listLegalContracts: { provides: ["legalContractId"] },
  getLegalContract: { requires: ["legalContractId"] },
  requestContractReview: { requires: ["legalContractId"], provides: ["legalReviewId"] },
  getContractReviewStatus: { requires: ["legalReviewId"] },
  listNDAs: { provides: ["ndaId"] },
  getNDA: { requires: ["ndaId"] },
  listPolicies: { provides: ["policyId"] },
  getPolicy: { requires: ["policyId"] },
  updatePolicy: { requires: ["policyId"] },

  // ── Facilities ────────────────────────────────────────────
  listRooms: { provides: ["roomId"] },
  bookRoom: { requires: ["roomId"], provides: ["bookingId"] },
  cancelRoomBooking: { requires: ["bookingId"] },
  getRoomSchedule: { requires: ["roomId"] },
  listMaintenanceRequests: { provides: ["maintenanceRequestId"] },
  getMaintenanceStatus: { requires: ["maintenanceRequestId"] },

  // ── Communications ────────────────────────────────────────
  listSurveys: { provides: ["surveyId"] },
  getSurvey: { requires: ["surveyId"] },
  getSurveyResults: { requires: ["surveyId"] },
  submitSurveyResponse: { requires: ["surveyId"] },
  listAnnouncements: { provides: ["announcementId"] },
  getAnnouncement: { requires: ["announcementId"] },
  createNewsletter: { provides: ["newsletterId"] },
  getNewsletter: { requires: ["newsletterId"] },
  sendNewsletter: { requires: ["newsletterId"] },

  // ── Compliance ────────────────────────────────────────────
  acknowledgePolicy: { requires: ["employeeId", "policyId"] },
  getComplianceStatus: { requires: ["employeeId"] },

  // ── Reporting ─────────────────────────────────────────────
  getHeadcount: {},
  getAttrition: {},
};
