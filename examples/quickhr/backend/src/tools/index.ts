/**
 * Tool definitions and handlers for QuickHR backend.
 * ~150 tools across 10 categories: employees, payroll, time-off, onboarding, recruiting, compliance, benefits, admin, reporting, learning
 */

import {
  employees,
  getEmployeeById,
  getEmployeesByDepartment,
  getEmployeesByStatus,
  addEmployee as addEmployeeToData,
  updateEmployee as updateEmployeeInData,
  type Employee,
} from "../data/employees.js";
import {
  timeOffRequests,
  getPTOBalance as getPTOBalanceData,
  createRequest,
  updateRequestStatus,
  getRequestsByEmployee,
} from "../data/time-off.js";

// =============================================================================
// Types
// =============================================================================

export type ToolCategory =
  | "employees"
  | "payroll"
  | "time-off"
  | "onboarding"
  | "recruiting"
  | "compliance"
  | "benefits"
  | "admin"
  | "reporting"
  | "learning";

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: Record<string, unknown>;
  adminOnly?: boolean;
  metadata?: Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

// =============================================================================
// Helper Functions
// =============================================================================

function generateId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
}

// =============================================================================
// Tool Definitions (54 tools)
// =============================================================================

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // -------------------------------------------------------------------------
  // EMPLOYEES (8 tools)
  // -------------------------------------------------------------------------
  {
    name: "viewEmployee",
    description:
      "View detailed employee profile including role, department, start date, and contact info",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "listEmployees",
    description:
      "List all employees with optional filters by department or status",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        department: { type: "string", description: "Filter by department" },
        status: {
          type: "string",
          enum: ["active", "inactive", "onboarding"],
          description: "Filter by status",
        },
        limit: { type: "number", description: "Max results to return" },
      },
      required: [],
    },
  },
  {
    name: "addEmployee",
    description:
      "Add a new employee to the system (creates initial record, does not trigger onboarding)",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Employee full name" },
        email: { type: "string", description: "Employee email" },
        role: { type: "string", description: "Job title" },
        department: { type: "string", description: "Department" },
        startDate: { type: "string", description: "Start date (YYYY-MM-DD)" },
        managerId: { type: "string", description: "Manager employee ID" },
      },
      required: ["name", "email", "role", "department", "startDate"],
    },
  },
  {
    name: "updateEmployee",
    description:
      "Update employee information such as role, department, or contact details",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        updates: {
          type: "object",
          description: "Fields to update",
          properties: {
            role: { type: "string" },
            department: { type: "string" },
            email: { type: "string" },
          },
        },
      },
      required: ["employeeId", "updates"],
    },
  },
  {
    name: "getOrgChart",
    description: "Get organizational chart showing reporting structure",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        departmentId: { type: "string", description: "Filter by department" },
        managerId: { type: "string", description: "Start from specific manager" },
      },
      required: [],
    },
  },
  {
    name: "searchEmployees",
    description: "Search employees by name, email, or role",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "getEmployeeDocuments",
    description:
      "List documents associated with an employee (contracts, IDs, certifications)",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        type: {
          type: "string",
          enum: ["contract", "id", "certification", "other"],
          description: "Document type filter",
        },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "terminateEmployee",
    description:
      "Initiate employee termination process (triggers offboarding workflow)",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        reason: { type: "string", description: "Termination reason" },
        lastDay: { type: "string", description: "Last working day" },
        type: {
          type: "string",
          enum: ["voluntary", "involuntary"],
          description: "Termination type",
        },
      },
      required: ["employeeId", "reason", "lastDay", "type"],
    },
  },
  {
    name: "getPerformanceReview",
    description: "Retrieve employee's performance review history and ratings",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        year: { type: "number", description: "Review year" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "getEmployeeGoals",
    description: "Get employee's current goals and OKRs with progress tracking",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        status: { type: "string", enum: ["active", "completed", "all"], description: "Goal status filter" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "setEmployeeGoals",
    description: "Set or update employee goals and OKRs",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        goals: { type: "array", items: { type: "object" }, description: "Goals to set" },
        quarter: { type: "string", description: "Quarter (Q1, Q2, Q3, Q4)" },
      },
      required: ["employeeId", "goals"],
    },
  },
  {
    name: "getEmployeeSkills",
    description: "List employee skills, certifications, and proficiency levels",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "updateEmployeeSkills",
    description: "Update employee skill profile and proficiency levels",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        skills: { type: "array", items: { type: "object" }, description: "Skills to update" },
      },
      required: ["employeeId", "skills"],
    },
  },
  {
    name: "getCertifications",
    description: "Get employee certifications with expiration dates",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        status: { type: "string", enum: ["valid", "expired", "expiring_soon"], description: "Filter by status" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "getAttendanceRecord",
    description: "View employee attendance history and patterns",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
      },
      required: ["employeeId", "startDate", "endDate"],
    },
  },
  {
    name: "recordAttendance",
    description: "Record employee attendance (clock in/out)",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        type: { type: "string", enum: ["clock_in", "clock_out"], description: "Attendance type" },
        timestamp: { type: "string", description: "Timestamp" },
      },
      required: ["employeeId", "type"],
    },
  },
  {
    name: "getDirectReports",
    description: "List all direct reports for a manager",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        managerId: { type: "string", description: "Manager employee ID" },
      },
      required: ["managerId"],
    },
  },
  {
    name: "transferEmployee",
    description: "Transfer employee to different department or location",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        newDepartment: { type: "string", description: "New department" },
        newManager: { type: "string", description: "New manager ID" },
        effectiveDate: { type: "string", description: "Transfer effective date" },
      },
      required: ["employeeId", "newDepartment", "effectiveDate"],
    },
  },
  {
    name: "promoteEmployee",
    description: "Promote employee to new role with updated compensation",
    category: "employees",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        newRole: { type: "string", description: "New role title" },
        newSalary: { type: "number", description: "New salary" },
        effectiveDate: { type: "string", description: "Promotion effective date" },
      },
      required: ["employeeId", "newRole", "effectiveDate"],
    },
  },

  // -------------------------------------------------------------------------
  // PAYROLL (15 tools)
  // -------------------------------------------------------------------------
  {
    name: "calculatePayroll",
    description:
      "Calculate payroll for a specific pay period including base salary, bonuses, deductions",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", description: "Pay period (YYYY-MM)" },
        departmentId: { type: "string", description: "Filter by department" },
      },
      required: ["period"],
    },
  },
  {
    name: "approvePayroll",
    description: "Approve calculated payroll for processing",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        payrollId: { type: "string", description: "Payroll ID" },
        approverId: { type: "string", description: "Approver employee ID" },
      },
      required: ["payrollId", "approverId"],
    },
  },
  {
    name: "generatePayslips",
    description: "Generate and distribute payslips to employees",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        payrollId: { type: "string", description: "Payroll ID" },
        deliveryMethod: {
          type: "string",
          enum: ["email", "portal", "both"],
          description: "Delivery method",
        },
      },
      required: ["payrollId", "deliveryMethod"],
    },
  },
  {
    name: "getPayrollHistory",
    description: "View payroll history for an employee or department",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        departmentId: { type: "string", description: "Department ID" },
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
      },
      required: [],
    },
  },
  {
    name: "adjustSalary",
    description: "Adjust employee salary (raise, promotion, correction)",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        newSalary: { type: "number", description: "New annual salary" },
        effectiveDate: { type: "string", description: "Effective date" },
        reason: { type: "string", description: "Adjustment reason" },
      },
      required: ["employeeId", "newSalary", "effectiveDate", "reason"],
    },
  },
  {
    name: "addBonus",
    description: "Add a one-time bonus to an employee's next payroll",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        amount: { type: "number", description: "Bonus amount" },
        reason: { type: "string", description: "Bonus reason" },
        payPeriod: { type: "string", description: "Pay period for bonus" },
      },
      required: ["employeeId", "amount", "reason", "payPeriod"],
    },
  },
  {
    name: "getTaxReports",
    description: "Generate tax reports for compliance (W-2, 1099, etc.)",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        year: { type: "number", description: "Tax year" },
        reportType: {
          type: "string",
          enum: ["W2", "1099", "quarterly", "annual"],
          description: "Report type",
        },
      },
      required: ["year", "reportType"],
    },
  },
  {
    name: "getDeductions",
    description: "View employee payroll deductions (taxes, benefits, garnishments)",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        period: { type: "string", description: "Pay period" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "updateDeductions",
    description: "Update employee payroll deductions",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        deductions: { type: "array", items: { type: "object" }, description: "Deductions to update" },
        effectiveDate: { type: "string", description: "Effective date" },
      },
      required: ["employeeId", "deductions"],
    },
  },
  {
    name: "submitExpense",
    description: "Submit an expense report for reimbursement",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        amount: { type: "number", description: "Expense amount" },
        category: { type: "string", description: "Expense category" },
        description: { type: "string", description: "Description" },
        receiptUrl: { type: "string", description: "Receipt URL" },
      },
      required: ["employeeId", "amount", "category", "description"],
    },
  },
  {
    name: "approveExpense",
    description: "Approve or reject an expense report",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        expenseId: { type: "string", description: "Expense report ID" },
        decision: { type: "string", enum: ["approve", "reject"], description: "Decision" },
        reason: { type: "string", description: "Reason for decision" },
      },
      required: ["expenseId", "decision"],
    },
  },
  {
    name: "getExpenseHistory",
    description: "View expense report history for an employee",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        status: { type: "string", enum: ["pending", "approved", "rejected", "all"], description: "Status filter" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "getBonusHistory",
    description: "View bonus payment history for an employee",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "getPayrollSummary",
    description: "Get payroll summary and statistics for a period",
    category: "payroll",
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", description: "Pay period" },
        departmentId: { type: "string", description: "Filter by department" },
      },
      required: ["period"],
    },
  },

  // -------------------------------------------------------------------------
  // TIME & PTO (20 tools)
  // -------------------------------------------------------------------------
  {
    name: "listTimeOffRequests",
    description: "List all time off/PTO requests with optional filters by status or employee",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "approved", "rejected"], description: "Filter by request status" },
        employeeId: { type: "string", description: "Filter by employee ID" },
      },
      required: [],
    },
  },
  {
    name: "viewTimesheet",
    description: "View employee timesheet for a specific period",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        startDate: { type: "string", description: "Period start date" },
        endDate: { type: "string", description: "Period end date" },
      },
      required: ["employeeId", "startDate", "endDate"],
    },
  },
  {
    name: "approveTimesheet",
    description: "Approve an employee's submitted timesheet",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        timesheetId: { type: "string", description: "Timesheet ID" },
        approverId: { type: "string", description: "Approver employee ID" },
      },
      required: ["timesheetId", "approverId"],
    },
  },
  {
    name: "requestPTO",
    description: "Submit a PTO (paid time off) request for an employee",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        startDate: { type: "string", description: "PTO start date" },
        endDate: { type: "string", description: "PTO end date" },
        type: {
          type: "string",
          enum: ["vacation", "sick", "personal"],
          description: "PTO type",
        },
        notes: { type: "string", description: "Additional notes" },
      },
      required: ["employeeId", "startDate", "endDate", "type"],
    },
  },
  {
    name: "approvePTO",
    description: "Approve or deny a pending PTO request",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "PTO request ID" },
        decision: {
          type: "string",
          enum: ["approve", "deny"],
          description: "Approval decision",
        },
        reason: { type: "string", description: "Reason for decision" },
      },
      required: ["requestId", "decision"],
    },
  },
  {
    name: "getPTOBalance",
    description: "Check remaining PTO balance for an employee",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "getTeamCalendar",
    description: "View team availability calendar showing PTO and holidays",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        teamId: { type: "string", description: "Team/department ID" },
        month: { type: "number", description: "Month (1-12)" },
        year: { type: "number", description: "Year" },
      },
      required: ["teamId", "month", "year"],
    },
  },
  {
    name: "exportTimeReports",
    description: "Export time tracking reports for billing or analysis",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Report start date" },
        endDate: { type: "string", description: "Report end date" },
        format: {
          type: "string",
          enum: ["csv", "pdf", "excel"],
          description: "Export format",
        },
        groupBy: {
          type: "string",
          enum: ["employee", "project", "department"],
          description: "Grouping option",
        },
      },
      required: ["startDate", "endDate", "format"],
    },
  },
  {
    name: "getHolidays",
    description: "Get company holidays for a specific year",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        year: { type: "number", description: "Year" },
        region: { type: "string", description: "Region/country" },
      },
      required: ["year"],
    },
  },
  {
    name: "cancelPTORequest",
    description: "Cancel a pending or approved PTO request",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "PTO request ID" },
        reason: { type: "string", description: "Cancellation reason" },
      },
      required: ["requestId"],
    },
  },
  {
    name: "getOvertimeHours",
    description: "View overtime hours worked by employee",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
      },
      required: ["employeeId", "startDate", "endDate"],
    },
  },
  {
    name: "approveOvertime",
    description: "Approve overtime hours for an employee",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        overtimeId: { type: "string", description: "Overtime request ID" },
        approverId: { type: "string", description: "Approver employee ID" },
      },
      required: ["overtimeId", "approverId"],
    },
  },
  {
    name: "getShiftSchedule",
    description: "View employee shift schedule",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        weekOf: { type: "string", description: "Week start date" },
      },
      required: ["employeeId", "weekOf"],
    },
  },
  {
    name: "updateShiftSchedule",
    description: "Update employee shift schedule",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        shifts: { type: "array", items: { type: "object" }, description: "Shift assignments" },
      },
      required: ["employeeId", "shifts"],
    },
  },
  {
    name: "swapShift",
    description: "Request or approve a shift swap between employees",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        requesterId: { type: "string", description: "Requesting employee ID" },
        targetId: { type: "string", description: "Target employee ID" },
        shiftDate: { type: "string", description: "Shift date to swap" },
      },
      required: ["requesterId", "targetId", "shiftDate"],
    },
  },
  {
    name: "getLeaveTypes",
    description: "Get available leave types and their policies",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "requestLeaveOfAbsence",
    description: "Request extended leave of absence (FMLA, personal, etc.)",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        leaveType: { type: "string", description: "Type of leave" },
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "Expected end date" },
        reason: { type: "string", description: "Reason for leave" },
      },
      required: ["employeeId", "leaveType", "startDate"],
    },
  },
  {
    name: "getAbsenceHistory",
    description: "View all absences for an employee",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        year: { type: "number", description: "Year" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "getTeamAvailability",
    description: "Check team availability for a specific date range",
    category: "time-off",
    parameters: {
      type: "object",
      properties: {
        teamId: { type: "string", description: "Team/department ID" },
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
      },
      required: ["teamId", "startDate", "endDate"],
    },
  },

  // -------------------------------------------------------------------------
  // ONBOARDING (15 tools)
  // -------------------------------------------------------------------------
  {
    name: "startOnboarding",
    description: "Initiate the onboarding workflow for a new employee",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        startDate: { type: "string", description: "Start date" },
        buddyId: { type: "string", description: "Onboarding buddy ID" },
      },
      required: ["employeeId", "startDate"],
    },
  },
  {
    name: "sendOfferLetter",
    description: "Generate and send offer letter to a candidate",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        candidateId: { type: "string", description: "Candidate ID" },
        role: { type: "string", description: "Job title" },
        salary: { type: "number", description: "Annual salary" },
        startDate: { type: "string", description: "Proposed start date" },
        benefits: {
          type: "array",
          items: { type: "string" },
          description: "Benefits to include",
        },
      },
      required: ["candidateId", "role", "salary", "startDate", "benefits"],
    },
  },
  {
    name: "createAccounts",
    description:
      "Create IT accounts for new employee (email, Slack, tools)",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        systems: {
          type: "array",
          items: { type: "string" },
          description: "Systems to create accounts for",
        },
      },
      required: ["employeeId", "systems"],
    },
  },
  {
    name: "scheduleOrientation",
    description: "Schedule orientation sessions for new employee",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        sessions: {
          type: "array",
          items: { type: "string" },
          description: "Orientation sessions",
        },
        preferredDates: {
          type: "array",
          items: { type: "string" },
          description: "Preferred dates",
        },
      },
      required: ["employeeId", "sessions"],
    },
  },
  {
    name: "assignEquipment",
    description:
      "Assign and ship equipment to new employee (laptop, monitor, etc.)",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        items: {
          type: "array",
          items: { type: "string" },
          description: "Equipment items",
        },
        shippingAddress: { type: "string", description: "Shipping address" },
      },
      required: ["employeeId", "items", "shippingAddress"],
    },
  },
  {
    name: "assignMentor",
    description: "Assign an onboarding buddy/mentor to new employee",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "New employee ID" },
        mentorId: { type: "string", description: "Mentor employee ID" },
      },
      required: ["employeeId", "mentorId"],
    },
  },
  {
    name: "getOnboardingStatus",
    description: "Check progress of an employee's onboarding",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "completeOnboardingTask",
    description: "Mark an onboarding task as complete",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        onboardingId: { type: "string", description: "Onboarding ID" },
        taskId: { type: "string", description: "Task ID" },
        notes: { type: "string", description: "Completion notes" },
      },
      required: ["onboardingId", "taskId"],
    },
  },
  {
    name: "getOnboardingChecklist",
    description: "Get the standard onboarding checklist for a role",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", description: "Job role" },
        department: { type: "string", description: "Department" },
      },
      required: [],
    },
  },
  {
    name: "getOnboardingMetrics",
    description: "Get onboarding completion metrics and statistics",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
        department: { type: "string", description: "Filter by department" },
      },
      required: [],
    },
  },
  {
    name: "getRampGoals",
    description: "Get 30/60/90 day ramp-up goals for new hire",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "setRampGoals",
    description: "Set 30/60/90 day ramp-up goals for new hire",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        goals: { type: "object", description: "Goals by period (30/60/90)" },
      },
      required: ["employeeId", "goals"],
    },
  },
  {
    name: "scheduleWelcomeMeeting",
    description: "Schedule welcome meeting with team for new hire",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        attendees: { type: "array", items: { type: "string" }, description: "Attendee IDs" },
        preferredDate: { type: "string", description: "Preferred date" },
      },
      required: ["employeeId", "attendees"],
    },
  },
  {
    name: "requestBadge",
    description: "Request building access badge for new employee",
    category: "onboarding",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        accessLevel: { type: "string", description: "Access level" },
        locations: { type: "array", items: { type: "string" }, description: "Building locations" },
      },
      required: ["employeeId", "accessLevel"],
    },
  },

  // -------------------------------------------------------------------------
  // RECRUITING (20 tools)
  // -------------------------------------------------------------------------
  {
    name: "postJob",
    description: "Create and publish a job posting",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Job title" },
        department: { type: "string", description: "Department" },
        description: { type: "string", description: "Job description" },
        requirements: {
          type: "array",
          items: { type: "string" },
          description: "Job requirements",
        },
        salary: {
          type: "object",
          properties: {
            min: { type: "number" },
            max: { type: "number" },
          },
          description: "Salary range",
        },
        remote: { type: "boolean", description: "Remote position" },
      },
      required: ["title", "department", "description", "requirements", "remote"],
    },
  },
  {
    name: "listCandidates",
    description: "List candidates for a job posting",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job posting ID" },
        stage: {
          type: "string",
          enum: ["applied", "screening", "interview", "offer", "rejected"],
          description: "Pipeline stage filter",
        },
      },
      required: ["jobId"],
    },
  },
  {
    name: "reviewApplication",
    description: "Review a candidate's application and materials",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        candidateId: { type: "string", description: "Candidate ID" },
      },
      required: ["candidateId"],
    },
  },
  {
    name: "scheduleInterview",
    description: "Schedule an interview with a candidate",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        candidateId: { type: "string", description: "Candidate ID" },
        interviewerIds: {
          type: "array",
          items: { type: "string" },
          description: "Interviewer IDs",
        },
        type: {
          type: "string",
          enum: ["phone", "video", "onsite"],
          description: "Interview type",
        },
        duration: { type: "number", description: "Duration in minutes" },
        preferredTimes: {
          type: "array",
          items: { type: "string" },
          description: "Preferred time slots",
        },
      },
      required: ["candidateId", "interviewerIds", "type", "duration"],
    },
  },
  {
    name: "submitInterviewFeedback",
    description: "Submit feedback after interviewing a candidate",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        interviewId: { type: "string", description: "Interview ID" },
        rating: {
          type: "number",
          minimum: 1,
          maximum: 5,
          description: "Overall rating (1-5)",
        },
        recommendation: {
          type: "string",
          enum: ["strong_yes", "yes", "no", "strong_no"],
          description: "Hiring recommendation",
        },
        notes: { type: "string", description: "Detailed notes" },
        skills: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              rating: { type: "number" },
            },
          },
          description: "Skills assessment",
        },
      },
      required: ["interviewId", "rating", "recommendation", "notes", "skills"],
    },
  },
  {
    name: "moveCandidate",
    description: "Move candidate to a different stage in the pipeline",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        candidateId: { type: "string", description: "Candidate ID" },
        newStage: {
          type: "string",
          enum: ["screening", "interview", "offer", "rejected", "hired"],
          description: "New stage",
        },
        reason: { type: "string", description: "Reason for move" },
      },
      required: ["candidateId", "newStage"],
    },
  },
  {
    name: "sendRejection",
    description: "Send a rejection email to a candidate",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        candidateId: { type: "string", description: "Candidate ID" },
        template: {
          type: "string",
          enum: ["standard", "after_interview", "position_filled"],
          description: "Email template",
        },
        personalNote: { type: "string", description: "Personal note to add" },
      },
      required: ["candidateId", "template"],
    },
  },
  {
    name: "getRecruitingMetrics",
    description: "Get recruiting pipeline metrics and analytics",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Filter by job" },
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
      },
      required: [],
    },
  },
  {
    name: "getJobPostings",
    description: "List all active job postings",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "closed", "draft", "all"], description: "Status filter" },
        department: { type: "string", description: "Department filter" },
      },
      required: [],
    },
  },
  {
    name: "closeJobPosting",
    description: "Close a job posting",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job posting ID" },
        reason: { type: "string", enum: ["filled", "cancelled", "on_hold"], description: "Closing reason" },
      },
      required: ["jobId", "reason"],
    },
  },
  {
    name: "reopenJobPosting",
    description: "Reopen a closed job posting",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job posting ID" },
      },
      required: ["jobId"],
    },
  },
  {
    name: "getCandidateScorecard",
    description: "Get comprehensive scorecard for a candidate",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        candidateId: { type: "string", description: "Candidate ID" },
      },
      required: ["candidateId"],
    },
  },
  {
    name: "rescheduleInterview",
    description: "Reschedule an existing interview",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        interviewId: { type: "string", description: "Interview ID" },
        newDateTime: { type: "string", description: "New date and time" },
        reason: { type: "string", description: "Reason for reschedule" },
      },
      required: ["interviewId", "newDateTime"],
    },
  },
  {
    name: "cancelInterview",
    description: "Cancel a scheduled interview",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        interviewId: { type: "string", description: "Interview ID" },
        reason: { type: "string", description: "Cancellation reason" },
        notifyCandidate: { type: "boolean", description: "Send notification" },
      },
      required: ["interviewId", "reason"],
    },
  },
  {
    name: "getReferrals",
    description: "Get employee referrals for job postings",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job posting ID" },
        referrerId: { type: "string", description: "Referring employee ID" },
      },
      required: [],
    },
  },
  {
    name: "submitReferral",
    description: "Submit an employee referral for a position",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        referrerId: { type: "string", description: "Referring employee ID" },
        candidateName: { type: "string", description: "Candidate name" },
        candidateEmail: { type: "string", description: "Candidate email" },
        jobId: { type: "string", description: "Job posting ID" },
        relationship: { type: "string", description: "How they know each other" },
      },
      required: ["referrerId", "candidateName", "candidateEmail", "jobId"],
    },
  },
  {
    name: "getInterviewAvailability",
    description: "Get interviewer availability for scheduling",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        interviewerIds: { type: "array", items: { type: "string" }, description: "Interviewer IDs" },
        dateRange: { type: "object", description: "Date range to check" },
        duration: { type: "number", description: "Interview duration in minutes" },
      },
      required: ["interviewerIds", "dateRange", "duration"],
    },
  },
  {
    name: "createTalentPool",
    description: "Create a talent pool for future openings",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Pool name" },
        criteria: { type: "object", description: "Pool criteria" },
      },
      required: ["name"],
    },
  },
  {
    name: "addToTalentPool",
    description: "Add candidate to talent pool",
    category: "recruiting",
    parameters: {
      type: "object",
      properties: {
        poolId: { type: "string", description: "Talent pool ID" },
        candidateId: { type: "string", description: "Candidate ID" },
      },
      required: ["poolId", "candidateId"],
    },
  },

  // -------------------------------------------------------------------------
  // COMPLIANCE (15 tools)
  // -------------------------------------------------------------------------
  {
    name: "generateEEOReport",
    description: "Generate Equal Employment Opportunity compliance report",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        year: { type: "number", description: "Report year" },
        reportType: {
          type: "string",
          enum: ["EEO-1", "VETS-4212", "AAP"],
          description: "Report type",
        },
      },
      required: ["year", "reportType"],
    },
  },
  {
    name: "runComplianceAudit",
    description: "Run compliance audit on HR data and processes",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        auditType: {
          type: "string",
          enum: ["i9", "benefits", "safety", "general"],
          description: "Audit type",
        },
        scope: {
          type: "string",
          enum: ["company", "department"],
          description: "Audit scope",
        },
        departmentId: { type: "string", description: "Department to audit" },
      },
      required: ["auditType"],
    },
  },
  {
    name: "getAuditTrail",
    description: "View audit trail of changes to employee records",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Filter by employee" },
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
        actionType: { type: "string", description: "Action type filter" },
      },
      required: ["startDate", "endDate"],
    },
  },
  {
    name: "checkPolicyCompliance",
    description: "Check if an action complies with company policies",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to check" },
        context: { type: "object", description: "Action context" },
      },
      required: ["action", "context"],
    },
  },
  {
    name: "updateHandbook",
    description: "Update employee handbook with new policies",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        section: { type: "string", description: "Handbook section" },
        content: { type: "string", description: "New content" },
        effectiveDate: { type: "string", description: "Effective date" },
        requiresAck: {
          type: "boolean",
          description: "Requires employee acknowledgment",
        },
      },
      required: ["section", "content", "effectiveDate", "requiresAck"],
    },
  },
  {
    name: "getTrainingCompliance",
    description: "Check mandatory training completion status",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        training: {
          type: "string",
          enum: ["harassment", "safety", "security", "all"],
          description: "Training type",
        },
        departmentId: { type: "string", description: "Filter by department" },
      },
      required: ["training"],
    },
  },
  {
    name: "getIncidentReports",
    description: "View workplace incident reports",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["safety", "harassment", "discrimination", "other"], description: "Incident type" },
        status: { type: "string", enum: ["open", "investigating", "closed"], description: "Status filter" },
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
      },
      required: [],
    },
  },
  {
    name: "fileIncidentReport",
    description: "File a new workplace incident report",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "Incident type" },
        description: { type: "string", description: "Incident description" },
        date: { type: "string", description: "Incident date" },
        involvedParties: { type: "array", items: { type: "string" }, description: "Employee IDs involved" },
        witnesses: { type: "array", items: { type: "string" }, description: "Witness employee IDs" },
      },
      required: ["type", "description", "date"],
    },
  },
  {
    name: "fileWorkersCompClaim",
    description: "File a workers compensation claim",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        incidentDate: { type: "string", description: "Date of incident" },
        injuryDescription: { type: "string", description: "Injury description" },
        medicalTreatment: { type: "string", description: "Medical treatment received" },
      },
      required: ["employeeId", "incidentDate", "injuryDescription"],
    },
  },
  {
    name: "getLicenseExpiry",
    description: "Check professional license expiration dates",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        daysUntilExpiry: { type: "number", description: "Filter by days until expiry" },
      },
      required: [],
    },
  },
  {
    name: "updateLicense",
    description: "Update employee professional license information",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        licenseType: { type: "string", description: "License type" },
        licenseNumber: { type: "string", description: "License number" },
        expiryDate: { type: "string", description: "Expiry date" },
      },
      required: ["employeeId", "licenseType", "licenseNumber", "expiryDate"],
    },
  },
  {
    name: "getBackgroundCheckStatus",
    description: "Check status of background checks",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        candidateId: { type: "string", description: "Candidate ID" },
      },
      required: [],
    },
  },
  {
    name: "initiateBackgroundCheck",
    description: "Initiate background check for candidate or employee",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        subjectId: { type: "string", description: "Subject ID (employee or candidate)" },
        checkType: { type: "string", enum: ["criminal", "employment", "education", "credit", "full"], description: "Check type" },
      },
      required: ["subjectId", "checkType"],
    },
  },
  {
    name: "getI9Status",
    description: "Check I-9 verification status for employees",
    category: "compliance",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        status: { type: "string", enum: ["pending", "verified", "reverification_needed"], description: "Status filter" },
      },
      required: [],
    },
  },

  // -------------------------------------------------------------------------
  // BENEFITS (15 tools)
  // -------------------------------------------------------------------------
  {
    name: "enrollBenefits",
    description: "Enroll employee in benefits package",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        plans: {
          type: "object",
          properties: {
            health: { type: "string" },
            dental: { type: "string" },
            vision: { type: "string" },
            retirement: { type: "string" },
            lifeInsurance: { type: "string" },
          },
          description: "Benefits plans to enroll in",
        },
      },
      required: ["employeeId", "plans"],
    },
  },
  {
    name: "updateDependents",
    description: "Add or update dependents for benefits coverage",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        dependents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              relationship: { type: "string" },
              dob: { type: "string" },
              ssn: { type: "string" },
            },
          },
          description: "Dependents list",
        },
      },
      required: ["employeeId", "dependents"],
    },
  },
  {
    name: "compareBenefitPlans",
    description: "Compare available benefit plans with costs and coverage",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["health", "dental", "vision"],
          description: "Plan type to compare",
        },
        employeeId: { type: "string", description: "Employee for personalized comparison" },
      },
      required: ["type"],
    },
  },
  {
    name: "getBenefitsSummary",
    description: "Get summary of employee's current benefits enrollment",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "process401kChange",
    description: "Process changes to 401k contribution",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        newContribution: {
          type: "number",
          description: "New contribution percentage",
        },
        investmentChanges: {
          type: "object",
          description: "Investment allocation changes",
        },
      },
      required: ["employeeId", "newContribution"],
    },
  },
  {
    name: "openEnrollmentStatus",
    description: "Check open enrollment period status and deadlines",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "getClaimStatus",
    description: "Check status of insurance claims",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        claimId: { type: "string", description: "Specific claim ID" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "submitClaim",
    description: "Submit a new insurance claim",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        claimType: { type: "string", enum: ["medical", "dental", "vision", "pharmacy"], description: "Claim type" },
        amount: { type: "number", description: "Claim amount" },
        serviceDate: { type: "string", description: "Date of service" },
        provider: { type: "string", description: "Provider name" },
      },
      required: ["employeeId", "claimType", "amount", "serviceDate", "provider"],
    },
  },
  {
    name: "getFSABalance",
    description: "Get FSA (Flexible Spending Account) balance and transactions",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        accountType: { type: "string", enum: ["medical", "dependent_care"], description: "FSA type" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "getHSAContributions",
    description: "View HSA contributions and investment options",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        year: { type: "number", description: "Year" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "updateHSAContribution",
    description: "Update HSA contribution amount",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        newContribution: { type: "number", description: "New monthly contribution" },
        effectiveDate: { type: "string", description: "Effective date" },
      },
      required: ["employeeId", "newContribution"],
    },
  },
  {
    name: "getWellnessPoints",
    description: "Check wellness program points and rewards",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "logWellnessActivity",
    description: "Log wellness activity for points",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        activity: { type: "string", description: "Activity type" },
        date: { type: "string", description: "Activity date" },
        proof: { type: "string", description: "Proof/documentation URL" },
      },
      required: ["employeeId", "activity", "date"],
    },
  },
  {
    name: "getLifeEventOptions",
    description: "Get benefit change options for life events",
    category: "benefits",
    parameters: {
      type: "object",
      properties: {
        eventType: { type: "string", enum: ["marriage", "birth", "divorce", "death", "job_loss_spouse"], description: "Life event type" },
      },
      required: ["eventType"],
    },
  },

  // -------------------------------------------------------------------------
  // ADMIN-ONLY (10 tools) - Should NEVER hydrate for regular users
  // -------------------------------------------------------------------------
  {
    name: "deleteEmployeeRecord",
    description:
      "ADMIN ONLY: Permanently delete employee record and all associated data",
    category: "admin",
    adminOnly: true,
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        confirmPhrase: { type: "string", description: "Confirmation phrase" },
        reason: { type: "string", description: "Deletion reason" },
      },
      required: ["employeeId", "confirmPhrase", "reason"],
    },
  },
  {
    name: "overridePayroll",
    description:
      "ADMIN ONLY: Override payroll calculations and force payment",
    category: "admin",
    adminOnly: true,
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        amount: { type: "number", description: "Override amount" },
        reason: { type: "string", description: "Override reason" },
        bypassApproval: { type: "boolean", description: "Bypass approval workflow" },
      },
      required: ["employeeId", "amount", "reason", "bypassApproval"],
    },
  },
  {
    name: "accessAllRecords",
    description:
      "ADMIN ONLY: Bulk access to all employee records without restrictions",
    category: "admin",
    adminOnly: true,
    parameters: {
      type: "object",
      properties: {
        exportFormat: { type: "string", description: "Export format" },
        includeSSN: { type: "boolean", description: "Include SSN data" },
        includeSalary: { type: "boolean", description: "Include salary data" },
      },
      required: ["exportFormat", "includeSSN", "includeSalary"],
    },
  },
  {
    name: "systemConfiguration",
    description:
      "ADMIN ONLY: Modify system configuration and security settings",
    category: "admin",
    adminOnly: true,
    parameters: {
      type: "object",
      properties: {
        settings: { type: "object", description: "Configuration settings" },
      },
      required: ["settings"],
    },
  },
  {
    name: "getSystemLogs",
    description: "ADMIN ONLY: View system logs and audit trail",
    category: "admin",
    adminOnly: true,
    parameters: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
        logLevel: { type: "string", enum: ["info", "warn", "error"], description: "Log level filter" },
      },
      required: ["startDate", "endDate"],
    },
  },
  {
    name: "exportAuditLogs",
    description: "ADMIN ONLY: Export audit logs for compliance",
    category: "admin",
    adminOnly: true,
    parameters: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
        format: { type: "string", enum: ["csv", "json", "pdf"], description: "Export format" },
      },
      required: ["startDate", "endDate", "format"],
    },
  },
  {
    name: "bulkImportEmployees",
    description: "ADMIN ONLY: Bulk import employees from CSV/Excel",
    category: "admin",
    adminOnly: true,
    parameters: {
      type: "object",
      properties: {
        fileUrl: { type: "string", description: "File URL" },
        format: { type: "string", enum: ["csv", "xlsx"], description: "File format" },
        dryRun: { type: "boolean", description: "Validate without importing" },
      },
      required: ["fileUrl", "format"],
    },
  },
  {
    name: "manageUserRoles",
    description: "ADMIN ONLY: Manage user roles and permissions",
    category: "admin",
    adminOnly: true,
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID" },
        roles: { type: "array", items: { type: "string" }, description: "Roles to assign" },
      },
      required: ["userId", "roles"],
    },
  },
  {
    name: "configureIntegration",
    description: "ADMIN ONLY: Configure third-party integrations",
    category: "admin",
    adminOnly: true,
    parameters: {
      type: "object",
      properties: {
        integration: { type: "string", description: "Integration name" },
        config: { type: "object", description: "Integration configuration" },
      },
      required: ["integration", "config"],
    },
  },

  // -------------------------------------------------------------------------
  // REPORTING (10 tools)
  // -------------------------------------------------------------------------
  {
    name: "getHeadcountReport",
    description: "Generate headcount report by department, location, or time period",
    category: "reporting",
    parameters: {
      type: "object",
      properties: {
        groupBy: { type: "string", enum: ["department", "location", "role", "manager"], description: "Grouping" },
        asOfDate: { type: "string", description: "Point-in-time date" },
      },
      required: [],
    },
  },
  {
    name: "getTurnoverReport",
    description: "Generate employee turnover and retention report",
    category: "reporting",
    parameters: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
        department: { type: "string", description: "Department filter" },
      },
      required: ["startDate", "endDate"],
    },
  },
  {
    name: "getDiversityReport",
    description: "Generate diversity and inclusion metrics report",
    category: "reporting",
    parameters: {
      type: "object",
      properties: {
        year: { type: "number", description: "Report year" },
        department: { type: "string", description: "Department filter" },
      },
      required: [],
    },
  },
  {
    name: "getCompensationReport",
    description: "Generate compensation analysis report",
    category: "reporting",
    parameters: {
      type: "object",
      properties: {
        department: { type: "string", description: "Department filter" },
        role: { type: "string", description: "Role filter" },
        includeBonus: { type: "boolean", description: "Include bonus data" },
      },
      required: [],
    },
  },
  {
    name: "getPerformanceReport",
    description: "Generate performance review summary report",
    category: "reporting",
    parameters: {
      type: "object",
      properties: {
        reviewCycle: { type: "string", description: "Review cycle" },
        department: { type: "string", description: "Department filter" },
      },
      required: ["reviewCycle"],
    },
  },
  {
    name: "getAbsenteeismReport",
    description: "Generate absenteeism and attendance report",
    category: "reporting",
    parameters: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
        department: { type: "string", description: "Department filter" },
      },
      required: ["startDate", "endDate"],
    },
  },
  {
    name: "getBenefitsUtilizationReport",
    description: "Generate benefits utilization report",
    category: "reporting",
    parameters: {
      type: "object",
      properties: {
        year: { type: "number", description: "Report year" },
        benefitType: { type: "string", enum: ["health", "dental", "vision", "401k", "all"], description: "Benefit type" },
      },
      required: ["year"],
    },
  },
  {
    name: "getRecruitingReport",
    description: "Generate recruiting funnel and pipeline report",
    category: "reporting",
    parameters: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Start date" },
        endDate: { type: "string", description: "End date" },
        department: { type: "string", description: "Department filter" },
      },
      required: ["startDate", "endDate"],
    },
  },
  {
    name: "getTrainingReport",
    description: "Generate training completion and compliance report",
    category: "reporting",
    parameters: {
      type: "object",
      properties: {
        year: { type: "number", description: "Report year" },
        trainingType: { type: "string", description: "Training type filter" },
      },
      required: ["year"],
    },
  },
  {
    name: "exportReport",
    description: "Export any generated report to file",
    category: "reporting",
    parameters: {
      type: "object",
      properties: {
        reportId: { type: "string", description: "Report ID" },
        format: { type: "string", enum: ["csv", "pdf", "xlsx"], description: "Export format" },
        recipients: { type: "array", items: { type: "string" }, description: "Email recipients" },
      },
      required: ["reportId", "format"],
    },
  },

  // -------------------------------------------------------------------------
  // LEARNING & DEVELOPMENT (10 tools)
  // -------------------------------------------------------------------------
  {
    name: "getCourses",
    description: "List available training courses and programs",
    category: "learning",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "Course category" },
        required: { type: "boolean", description: "Filter required courses" },
        format: { type: "string", enum: ["online", "in_person", "hybrid"], description: "Delivery format" },
      },
      required: [],
    },
  },
  {
    name: "enrollCourse",
    description: "Enroll employee in a training course",
    category: "learning",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        courseId: { type: "string", description: "Course ID" },
        sessionId: { type: "string", description: "Specific session ID" },
      },
      required: ["employeeId", "courseId"],
    },
  },
  {
    name: "getTrainingProgress",
    description: "View employee training progress and completion status",
    category: "learning",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        courseId: { type: "string", description: "Course ID filter" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "completeTraining",
    description: "Mark a training module as complete",
    category: "learning",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        courseId: { type: "string", description: "Course ID" },
        moduleId: { type: "string", description: "Module ID" },
        score: { type: "number", description: "Assessment score" },
      },
      required: ["employeeId", "courseId", "moduleId"],
    },
  },
  {
    name: "getSkillGaps",
    description: "Analyze skill gaps for an employee or team",
    category: "learning",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        teamId: { type: "string", description: "Team ID" },
        targetRole: { type: "string", description: "Target role for gap analysis" },
      },
      required: [],
    },
  },
  {
    name: "recommendCourses",
    description: "Get personalized course recommendations for employee",
    category: "learning",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        careerPath: { type: "string", description: "Career path focus" },
      },
      required: ["employeeId"],
    },
  },
  {
    name: "createLearningPath",
    description: "Create custom learning path for employee development",
    category: "learning",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Learning path name" },
        courseIds: { type: "array", items: { type: "string" }, description: "Course IDs in sequence" },
        targetRole: { type: "string", description: "Target role" },
      },
      required: ["name", "courseIds"],
    },
  },
  {
    name: "assignLearningPath",
    description: "Assign learning path to employee",
    category: "learning",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        pathId: { type: "string", description: "Learning path ID" },
        deadline: { type: "string", description: "Completion deadline" },
      },
      required: ["employeeId", "pathId"],
    },
  },
  {
    name: "getTrainingBudget",
    description: "Check training budget allocation and spending",
    category: "learning",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        departmentId: { type: "string", description: "Department ID" },
        year: { type: "number", description: "Budget year" },
      },
      required: [],
    },
  },
  {
    name: "requestExternalTraining",
    description: "Request approval for external training or conference",
    category: "learning",
    parameters: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee ID" },
        trainingName: { type: "string", description: "Training or conference name" },
        provider: { type: "string", description: "Training provider" },
        cost: { type: "number", description: "Total cost" },
        justification: { type: "string", description: "Business justification" },
      },
      required: ["employeeId", "trainingName", "cost", "justification"],
    },
  },

  // -------------------------------------------------------------------------
  // FRONTEND TOOLS (executed client-side)
  // -------------------------------------------------------------------------
  {
    name: "confirm_action",
    description:
      "Ask the user to confirm a destructive or sensitive action before proceeding. Returns whether the user confirmed or denied.",
    category: "admin" as ToolCategory,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Description of the action to confirm" },
        details: { type: "string", description: "Additional details about the action" },
      },
      required: ["action"],
    },
    metadata: { location: "frontend" },
  },
];

// =============================================================================
// Tool Handlers
// =============================================================================

// -------------------------------------------------------------------------
// EMPLOYEES handlers
// -------------------------------------------------------------------------

const viewEmployee: ToolHandler = async (args) => {
  const employee = getEmployeeById(args.employeeId as string);
  if (!employee) {
    return { error: "Employee not found" };
  }
  return employee;
};

const VALID_STATUSES = new Set(["active", "inactive", "onboarding"]);
const VALID_DEPARTMENTS = new Set(
  employees.map((e) => e.department.toLowerCase())
);

const listEmployees: ToolHandler = async (args) => {
  let result = [...employees];

  if (args.department) {
    const dept = (args.department as string).toLowerCase();
    if (VALID_DEPARTMENTS.has(dept)) {
      result = result.filter((e) => e.department.toLowerCase() === dept);
    }
  }
  if (args.status) {
    const status = (args.status as string).toLowerCase();
    if (VALID_STATUSES.has(status)) {
      result = result.filter((e) => e.status.toLowerCase() === status);
    }
  }
  if (args.limit) {
    result = result.slice(0, args.limit as number);
  }

  return { employees: result, total: result.length };
};

const addEmployee: ToolHandler = async (args) => {
  const newEmployee = addEmployeeToData({
    name: args.name as string,
    email: args.email as string,
    role: args.role as string,
    department: args.department as string,
    startDate: args.startDate as string,
    managerId: (args.managerId as string) || null,
    status: "onboarding",
  });
  return {
    employeeId: newEmployee.id,
    message: "Employee record created",
  };
};

const updateEmployee: ToolHandler = async (args) => {
  const updates = args.updates as Partial<Employee>;
  const updated = updateEmployeeInData(args.employeeId as string, updates);
  if (!updated) {
    return { error: "Employee not found" };
  }
  return {
    success: true,
    updated: Object.keys(updates),
  };
};

const getOrgChart: ToolHandler = async (args) => {
  const nodes = employees.map((e) => ({
    id: e.id,
    name: e.name,
    role: e.role,
    department: e.department,
    managerId: e.managerId,
    reports: employees.filter((r) => r.managerId === e.id).map((r) => r.id),
  }));

  if (args.departmentId) {
    return { nodes: nodes.filter((n) => n.department === args.departmentId) };
  }
  if (args.managerId) {
    const manager = nodes.find((n) => n.id === args.managerId);
    return { nodes: manager ? [manager, ...nodes.filter((n) => n.managerId === args.managerId)] : [] };
  }

  return { nodes };
};

const searchEmployees: ToolHandler = async (args) => {
  const query = (args.query as string).toLowerCase();
  const results = employees.filter(
    (e) =>
      e.name.toLowerCase().includes(query) ||
      e.email.toLowerCase().includes(query) ||
      e.role.toLowerCase().includes(query)
  );
  return { results, count: results.length };
};

const getEmployeeDocuments: ToolHandler = async (args) => {
  const employeeId = args.employeeId as string;
  const docs = [
    { id: `DOC-${employeeId}-1`, name: "Employment Contract", type: "contract", uploadDate: "2024-01-15", url: `/docs/${employeeId}/contract.pdf` },
    { id: `DOC-${employeeId}-2`, name: "ID Copy", type: "id", uploadDate: "2024-01-15", url: `/docs/${employeeId}/id.pdf` },
  ];

  if (args.type) {
    return { documents: docs.filter((d) => d.type === args.type) };
  }
  return { documents: docs };
};

const terminateEmployee: ToolHandler = async (args) => {
  const employee = getEmployeeById(args.employeeId as string);
  if (!employee) {
    return { error: "Employee not found" };
  }

  updateEmployeeInData(args.employeeId as string, { status: "inactive" });

  return {
    success: true,
    offboardingId: generateId("OFF-"),
    message: "Termination initiated, offboarding workflow started",
  };
};

const getPerformanceReview: ToolHandler = async (args) => {
  return {
    employeeId: args.employeeId,
    reviews: [
      { year: 2025, rating: 4, cycle: "Q4", feedback: "Excellent performance" },
      { year: 2024, rating: 3.5, cycle: "Q4", feedback: "Meets expectations" },
    ],
  };
};

const getEmployeeGoals: ToolHandler = async (args) => {
  return {
    goals: [
      { id: "G1", title: "Complete project X", status: "active", progress: 75 },
      { id: "G2", title: "Mentor new team member", status: "active", progress: 50 },
    ],
  };
};

const setEmployeeGoals: ToolHandler = async (args) => {
  return { success: true, goalsSet: (args.goals as unknown[]).length };
};

const getEmployeeSkills: ToolHandler = async (args) => {
  return {
    skills: [
      { name: "JavaScript", proficiency: "expert" },
      { name: "React", proficiency: "advanced" },
      { name: "TypeScript", proficiency: "advanced" },
    ],
  };
};

const updateEmployeeSkills: ToolHandler = async (args) => {
  return { success: true, updatedSkills: (args.skills as unknown[]).length };
};

const getCertifications: ToolHandler = async (args) => {
  return {
    certifications: [
      { name: "AWS Solutions Architect", expiry: "2026-06-15", status: "valid" },
      { name: "PMP", expiry: "2025-03-01", status: "expiring_soon" },
    ],
  };
};

const getAttendanceRecord: ToolHandler = async (args) => {
  return {
    records: [
      { date: args.startDate, status: "present", hoursWorked: 8 },
      { date: args.endDate, status: "present", hoursWorked: 8 },
    ],
    summary: { daysPresent: 20, daysAbsent: 1, avgHours: 8.2 },
  };
};

const recordAttendance: ToolHandler = async (args) => {
  return { success: true, timestamp: new Date().toISOString(), type: args.type };
};

const getDirectReports: ToolHandler = async (args) => {
  const reports = employees.filter((e) => e.managerId === args.managerId);
  return { directReports: reports, count: reports.length };
};

const transferEmployee: ToolHandler = async (args) => {
  return {
    success: true,
    transferId: generateId("TRF-"),
    message: `Transfer to ${args.newDepartment} scheduled for ${args.effectiveDate}`,
  };
};

const promoteEmployee: ToolHandler = async (args) => {
  return {
    success: true,
    promotionId: generateId("PRM-"),
    newRole: args.newRole,
    effectiveDate: args.effectiveDate,
  };
};

// -------------------------------------------------------------------------
// PAYROLL handlers
// -------------------------------------------------------------------------

const calculatePayroll: ToolHandler = async (args) => {
  const activeEmployees = employees.filter((e) => e.status === "active");
  const employeeCount = activeEmployees.length;
  const baseSalary = 75000;
  const totalGross = employeeCount * (baseSalary / 12);
  const totalDeductions = totalGross * 0.25;
  const totalNet = totalGross - totalDeductions;

  return {
    period: args.period as string,
    totalGross,
    totalDeductions,
    totalNet,
    employeeCount,
    breakdown: activeEmployees.map((e) => ({
      employeeId: e.id,
      name: e.name,
      gross: baseSalary / 12,
      net: (baseSalary / 12) * 0.75,
    })),
  };
};

const approvePayroll: ToolHandler = async (args) => {
  return {
    approved: true,
    processDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    message: `Payroll approved, will process on next business day`,
  };
};

const generatePayslips: ToolHandler = async (args) => {
  const activeEmployees = employees.filter((e) => e.status === "active");
  return {
    generated: activeEmployees.length,
    delivered: activeEmployees.length,
    failed: [],
  };
};

const getPayrollHistory: ToolHandler = async (args) => {
  const records = [
    { period: "2025-01", gross: 6250, net: 4687.5, deductions: 1562.5 },
    { period: "2024-12", gross: 6250, net: 4687.5, deductions: 1562.5 },
    { period: "2024-11", gross: 6250, net: 4687.5, deductions: 1562.5 },
  ];
  return { records };
};

const adjustSalary: ToolHandler = async (args) => {
  return {
    success: true,
    previousSalary: 75000,
    newSalary: args.newSalary as number,
    effectiveDate: args.effectiveDate as string,
  };
};

const addBonus: ToolHandler = async (args) => {
  return {
    bonusId: generateId("BON-"),
    amount: args.amount as number,
    payPeriod: args.payPeriod as string,
    message: `Bonus will be included in ${args.payPeriod} payroll`,
  };
};

const getTaxReports: ToolHandler = async (args) => {
  return {
    reportUrl: `https://hr.company.com/reports/${args.reportType}-${args.year}.pdf`,
    generatedAt: new Date().toISOString(),
    employeesIncluded: employees.filter((e) => e.status === "active").length,
  };
};

const getDeductions: ToolHandler = async (args) => {
  return {
    deductions: [
      { type: "Federal Tax", amount: 1200 },
      { type: "State Tax", amount: 400 },
      { type: "Health Insurance", amount: 250 },
      { type: "401k", amount: 375 },
    ],
  };
};

const updateDeductions: ToolHandler = async (args) => {
  return { success: true, updatedDeductions: (args.deductions as unknown[]).length };
};

const submitExpense: ToolHandler = async (args) => {
  return {
    expenseId: generateId("EXP-"),
    status: "pending",
    amount: args.amount,
    submittedAt: new Date().toISOString(),
  };
};

const approveExpense: ToolHandler = async (args) => {
  return {
    success: true,
    decision: args.decision,
    processedAt: new Date().toISOString(),
  };
};

const getExpenseHistory: ToolHandler = async (args) => {
  return {
    expenses: [
      { id: "EXP-001", amount: 150, category: "Travel", status: "approved", date: "2025-01-15" },
      { id: "EXP-002", amount: 45, category: "Meals", status: "pending", date: "2025-01-20" },
    ],
  };
};

const getBonusHistory: ToolHandler = async (args) => {
  return {
    bonuses: [
      { date: "2024-12-15", amount: 5000, reason: "Year-end performance" },
      { date: "2024-06-15", amount: 2500, reason: "Q2 achievement" },
    ],
  };
};

const getPayrollSummary: ToolHandler = async (args) => {
  return {
    period: args.period,
    totalGross: 450000,
    totalNet: 337500,
    employeeCount: employees.filter((e) => e.status === "active").length,
    averageSalary: 75000,
  };
};

// -------------------------------------------------------------------------
// TIME & PTO handlers
// -------------------------------------------------------------------------

const listTimeOffRequests: ToolHandler = async (args) => {
  let requests = [...timeOffRequests];

  if (args.status) {
    requests = requests.filter((r) => r.status === args.status);
  }
  if (args.employeeId) {
    requests = requests.filter((r) => r.employeeId === args.employeeId);
  }

  return { requests, total: requests.length };
};

const viewTimesheet: ToolHandler = async (args) => {
  const entries = [
    { date: args.startDate, hoursWorked: 8, project: "Project Alpha", status: "approved" },
    { date: args.endDate, hoursWorked: 8, project: "Project Alpha", status: "pending" },
  ];
  return {
    entries,
    totalHours: entries.reduce((sum, e) => sum + e.hoursWorked, 0),
  };
};

const approveTimesheet: ToolHandler = async (args) => {
  return {
    approved: true,
    hoursApproved: 40,
    message: "Timesheet approved",
  };
};

const requestPTO: ToolHandler = async (args) => {
  const employee = getEmployeeById(args.employeeId as string);
  const startDate = new Date(args.startDate as string);
  const endDate = new Date(args.endDate as string);
  const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  const request = createRequest({
    employeeId: args.employeeId as string,
    employeeName: employee?.name || "Unknown",
    type: args.type as "vacation" | "sick" | "personal",
    startDate: args.startDate as string,
    endDate: args.endDate as string,
    days,
    status: "pending",
    notes: args.notes as string,
  });

  return {
    requestId: request.id,
    status: "pending",
    daysRequested: days,
    message: "PTO request submitted for manager approval",
  };
};

const approvePTO: ToolHandler = async (args) => {
  const decision = args.decision as string;
  const newStatus = decision === "approve" ? "approved" : "rejected";
  updateRequestStatus(args.requestId as string, newStatus);

  return {
    success: true,
    newStatus,
    message: decision === "approve" ? "PTO approved" : "PTO denied",
  };
};

const getPTOBalance: ToolHandler = async (args) => {
  const balance = getPTOBalanceData(args.employeeId as string);
  if (!balance) {
    return {
      vacation: { used: 0, remaining: 15, total: 15 },
      sick: { used: 0, remaining: 10, total: 10 },
      personal: { used: 0, remaining: 3, total: 3 },
    };
  }
  return balance;
};

const getTeamCalendar: ToolHandler = async (args) => {
  const month = args.month as number;
  const year = args.year as number;
  const daysInMonth = new Date(year, month, 0).getDate();

  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
    const outOfOffice = timeOffRequests
      .filter((r) => r.startDate <= date && r.endDate >= date && r.status === "approved")
      .map((r) => r.employeeName);
    return { date, outOfOffice, holidays: [] };
  });

  return { days };
};

const exportTimeReports: ToolHandler = async (args) => {
  return {
    reportUrl: `https://hr.company.com/time-reports/${args.format}/${generateId("")}`,
    recordCount: employees.length * 20,
    totalHours: employees.length * 160,
  };
};

const getHolidays: ToolHandler = async (args) => {
  return {
    year: args.year,
    holidays: [
      { date: `${args.year}-01-01`, name: "New Year's Day" },
      { date: `${args.year}-07-04`, name: "Independence Day" },
      { date: `${args.year}-12-25`, name: "Christmas Day" },
    ],
  };
};

const cancelPTORequest: ToolHandler = async (args) => {
  return { success: true, requestId: args.requestId, status: "cancelled" };
};

const getOvertimeHours: ToolHandler = async (args) => {
  return {
    overtimeHours: [
      { week: "2025-01-06", hours: 5, approved: true },
      { week: "2025-01-13", hours: 3, approved: false },
    ],
    totalHours: 8,
  };
};

const approveOvertime: ToolHandler = async (args) => {
  return { success: true, overtimeId: args.overtimeId, status: "approved" };
};

const getShiftSchedule: ToolHandler = async (args) => {
  return {
    shifts: [
      { date: args.weekOf, start: "09:00", end: "17:00" },
      { date: args.weekOf, start: "09:00", end: "17:00" },
    ],
  };
};

const updateShiftSchedule: ToolHandler = async (args) => {
  return { success: true, shiftsUpdated: (args.shifts as unknown[]).length };
};

const swapShift: ToolHandler = async (args) => {
  return {
    swapId: generateId("SWP-"),
    status: "pending_approval",
    requesterId: args.requesterId,
    targetId: args.targetId,
  };
};

const getLeaveTypes: ToolHandler = async () => {
  return {
    leaveTypes: [
      { type: "vacation", accrualRate: "1.25 days/month", maxCarryover: 5 },
      { type: "sick", accrualRate: "0.83 days/month", maxCarryover: 0 },
      { type: "personal", accrualRate: "3 days/year", maxCarryover: 0 },
      { type: "parental", duration: "12-16 weeks", accrualRate: "N/A" },
    ],
  };
};

const requestLeaveOfAbsence: ToolHandler = async (args) => {
  return {
    requestId: generateId("LOA-"),
    status: "pending",
    leaveType: args.leaveType,
    startDate: args.startDate,
  };
};

const getAbsenceHistory: ToolHandler = async (args) => {
  return {
    absences: [
      { type: "vacation", startDate: "2025-01-06", endDate: "2025-01-10", days: 5 },
      { type: "sick", startDate: "2025-01-20", endDate: "2025-01-20", days: 1 },
    ],
    totalDays: 6,
  };
};

const getTeamAvailability: ToolHandler = async (args) => {
  return {
    availability: [
      { date: args.startDate, available: 8, outOfOffice: 2 },
      { date: args.endDate, available: 10, outOfOffice: 0 },
    ],
  };
};

// -------------------------------------------------------------------------
// ONBOARDING handlers
// -------------------------------------------------------------------------

const startOnboarding: ToolHandler = async (args) => {
  const tasks = [
    { id: "TASK-001", name: "Complete I-9", status: "pending" },
    { id: "TASK-002", name: "Setup workstation", status: "pending" },
    { id: "TASK-003", name: "Complete orientation", status: "pending" },
    { id: "TASK-004", name: "Meet team", status: "pending" },
  ];

  return {
    onboardingId: generateId("ONB-"),
    status: "started",
    tasks,
    message: "Onboarding workflow initiated",
  };
};

const sendOfferLetter: ToolHandler = async (args) => {
  return {
    offerId: generateId("OFFER-"),
    sentTo: `candidate-${args.candidateId}@email.com`,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    status: "sent",
  };
};

const createAccounts: ToolHandler = async (args) => {
  const systems = args.systems as string[];
  const created = systems.map((system) => ({
    system,
    username: `${args.employeeId}@company.com`,
    tempPassword: system === "email" ? generateId("TMP-") : undefined,
  }));

  return { created, failed: [] };
};

const scheduleOrientation: ToolHandler = async (args) => {
  const sessions = args.sessions as string[];
  const baseDate = new Date();

  const scheduled = sessions.map((session, i) => ({
    session,
    date: new Date(baseDate.getTime() + (i + 1) * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    time: "10:00 AM",
    location: "Conference Room A",
  }));

  return { scheduled };
};

const assignEquipment: ToolHandler = async (args) => {
  const items = args.items as string[];
  return {
    orderId: generateId("ORD-"),
    items: items.map((item) => ({ name: item, status: "ordered" })),
    estimatedDelivery: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    trackingUrl: `https://shipping.company.com/track/${generateId("")}`,
  };
};

const assignMentor: ToolHandler = async (args) => {
  const mentor = getEmployeeById(args.mentorId as string);
  return {
    success: true,
    mentor: {
      id: args.mentorId as string,
      name: mentor?.name || "Unknown Mentor",
      email: mentor?.email || "mentor@company.com",
    },
    message: "Mentor assigned, both parties notified",
  };
};

const getOnboardingStatus: ToolHandler = async (args) => {
  return {
    onboardingId: generateId("ONB-"),
    progress: "60%",
    completedTasks: [
      { id: "TASK-001", name: "Complete I-9" },
      { id: "TASK-002", name: "Setup workstation" },
    ],
    pendingTasks: [
      { id: "TASK-003", name: "Complete orientation" },
      { id: "TASK-004", name: "Meet team" },
    ],
    blockers: [],
  };
};

const completeOnboardingTask: ToolHandler = async (args) => {
  return {
    success: true,
    overallProgress: "80%",
    remainingTasks: 1,
  };
};

const getOnboardingChecklist: ToolHandler = async (args) => {
  return {
    checklist: [
      { task: "Complete I-9", category: "compliance", required: true },
      { task: "IT account setup", category: "it", required: true },
      { task: "Benefits enrollment", category: "hr", required: true },
      { task: "Meet team", category: "social", required: false },
    ],
  };
};

const getOnboardingMetrics: ToolHandler = async () => {
  return {
    avgCompletionTime: "14 days",
    completionRate: 92,
    activeOnboardings: 5,
    completedThisMonth: 12,
  };
};

const getRampGoals: ToolHandler = async (args) => {
  return {
    day30: ["Complete all training", "Ship first bug fix"],
    day60: ["Own small feature", "Present at team meeting"],
    day90: ["Lead small project", "Mentor new hire"],
  };
};

const setRampGoals: ToolHandler = async (args) => {
  return { success: true, goalsSet: Object.keys(args.goals as object).length };
};

const scheduleWelcomeMeeting: ToolHandler = async (args) => {
  return {
    meetingId: generateId("MTG-"),
    scheduled: true,
    date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
  };
};

const requestBadge: ToolHandler = async (args) => {
  return {
    requestId: generateId("BDG-"),
    status: "processing",
    estimatedDelivery: "3-5 business days",
  };
};

// -------------------------------------------------------------------------
// RECRUITING handlers
// -------------------------------------------------------------------------

const postJob: ToolHandler = async (args) => {
  return {
    jobId: generateId("JOB-"),
    status: "published",
    url: `https://careers.company.com/jobs/${generateId("")}`,
    postedTo: ["careers page", "LinkedIn", "Indeed"],
  };
};

const listCandidates: ToolHandler = async (args) => {
  const allCandidates = [
    { id: "CAND-001", name: "Alice Johnson", email: "alice@email.com", stage: "interview", appliedDate: "2025-01-20", rating: 4.2 },
    { id: "CAND-002", name: "Bob Smith", email: "bob@email.com", stage: "screening", appliedDate: "2025-01-25", rating: 3.8 },
    { id: "CAND-003", name: "Carol Williams", email: "carol@email.com", stage: "interview", appliedDate: "2025-01-22", rating: 4.5 },
  ];

  let candidates = allCandidates;
  if (args.stage) {
    candidates = candidates.filter((c) => c.stage === args.stage);
  }

  return { candidates, total: candidates.length };
};

const reviewApplication: ToolHandler = async (args) => {
  return {
    candidate: {
      id: args.candidateId,
      name: "Alice Johnson",
      email: "alice@email.com",
      phone: "+1-555-0123",
    },
    resume: {
      url: `https://hr.company.com/resumes/${args.candidateId}.pdf`,
      parsedSkills: ["JavaScript", "React", "TypeScript", "Node.js"],
    },
    coverLetter: "Dear Hiring Manager...",
    references: [
      { name: "John Doe", company: "Previous Corp", relation: "Manager" },
    ],
  };
};

const scheduleInterview: ToolHandler = async (args) => {
  const type = args.type as string;
  return {
    interviewId: generateId("INT-"),
    scheduledAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    meetingLink: type === "video" ? `https://meet.company.com/${generateId("")}` : undefined,
    location: type === "onsite" ? "Office HQ, Room 301" : undefined,
    calendar: "sent",
  };
};

const submitInterviewFeedback: ToolHandler = async (args) => {
  return {
    submitted: true,
    candidateScore: 4.2,
    feedbackCount: 3,
  };
};

const moveCandidate: ToolHandler = async (args) => {
  return {
    success: true,
    previousStage: "interview",
    newStage: args.newStage as string,
    message: `Candidate moved to ${args.newStage}`,
  };
};

const sendRejection: ToolHandler = async (args) => {
  return {
    sent: true,
    to: `${args.candidateId}@email.com`,
    message: "Rejection email sent",
  };
};

const getRecruitingMetrics: ToolHandler = async () => {
  return {
    applications: 145,
    interviews: 32,
    offers: 5,
    hires: 3,
    avgTimeToHire: "23 days",
    conversionRates: {
      applicationToScreen: 0.45,
      screenToInterview: 0.60,
      interviewToOffer: 0.25,
      offerToHire: 0.80,
    },
  };
};

const getJobPostings: ToolHandler = async (args) => {
  return {
    postings: [
      { id: "JOB-001", title: "Senior Engineer", status: "active", applicants: 45 },
      { id: "JOB-002", title: "Product Manager", status: "active", applicants: 32 },
      { id: "JOB-003", title: "Designer", status: "closed", applicants: 28 },
    ],
  };
};

const closeJobPosting: ToolHandler = async (args) => {
  return { success: true, jobId: args.jobId, status: "closed", reason: args.reason };
};

const reopenJobPosting: ToolHandler = async (args) => {
  return { success: true, jobId: args.jobId, status: "active" };
};

const getCandidateScorecard: ToolHandler = async (args) => {
  return {
    candidateId: args.candidateId,
    overallScore: 4.2,
    interviewScores: [4.0, 4.5, 4.0],
    skillsAssessment: { technical: 4.5, communication: 4.0, culture: 4.0 },
    recommendation: "Strong hire",
  };
};

const rescheduleInterview: ToolHandler = async (args) => {
  return { success: true, interviewId: args.interviewId, newDateTime: args.newDateTime };
};

const cancelInterview: ToolHandler = async (args) => {
  return { success: true, interviewId: args.interviewId, notified: args.notifyCandidate };
};

const getReferrals: ToolHandler = async () => {
  return {
    referrals: [
      { id: "REF-001", candidateName: "John Smith", referrerName: "Jane Doe", status: "hired", bonus: 2500 },
      { id: "REF-002", candidateName: "Alice Brown", referrerName: "Bob Wilson", status: "interviewing", bonus: "pending" },
    ],
  };
};

const submitReferral: ToolHandler = async (args) => {
  return {
    referralId: generateId("REF-"),
    status: "submitted",
    candidateEmail: args.candidateEmail,
  };
};

const getInterviewAvailability: ToolHandler = async (args) => {
  return {
    availableSlots: [
      { datetime: "2025-02-10T10:00:00", available: true },
      { datetime: "2025-02-10T14:00:00", available: true },
      { datetime: "2025-02-11T11:00:00", available: true },
    ],
  };
};

const createTalentPool: ToolHandler = async (args) => {
  return { poolId: generateId("POOL-"), name: args.name, created: true };
};

const addToTalentPool: ToolHandler = async (args) => {
  return { success: true, poolId: args.poolId, candidateId: args.candidateId };
};

// -------------------------------------------------------------------------
// COMPLIANCE handlers
// -------------------------------------------------------------------------

const generateEEOReport: ToolHandler = async (args) => {
  return {
    reportId: generateId("RPT-"),
    status: "generated",
    downloadUrl: `https://hr.company.com/compliance/${args.reportType}-${args.year}.pdf`,
    dueDate: `${args.year}-03-31`,
    submissionStatus: "pending",
  };
};

const runComplianceAudit: ToolHandler = async (args) => {
  return {
    auditId: generateId("AUD-"),
    findings: [
      { severity: "low", issue: "2 I-9 forms missing signature", recommendation: "Collect signatures within 7 days" },
    ],
    passRate: "94%",
    actionItems: ["Review unsigned forms", "Schedule follow-up"],
  };
};

const getAuditTrail: ToolHandler = async (args) => {
  return {
    entries: [
      { timestamp: "2025-02-01T10:30:00Z", user: "EMP006", action: "salary_update", changes: { salary: { from: 70000, to: 75000 } }, ipAddress: "192.168.1.100" },
      { timestamp: "2025-01-28T14:15:00Z", user: "EMP006", action: "role_update", changes: { role: { from: "Engineer", to: "Senior Engineer" } }, ipAddress: "192.168.1.100" },
    ],
  };
};

const checkPolicyCompliance: ToolHandler = async (args) => {
  return {
    compliant: true,
    policies: [
      { name: "Remote Work Policy", status: "compliant", details: "Employee meets eligibility requirements" },
    ],
    warnings: [],
    blockers: [],
  };
};

const updateHandbook: ToolHandler = async (args) => {
  return {
    version: "2.4",
    updated: true,
    acknowledgmentsCampaign: args.requiresAck ? "started" : "not_required",
  };
};

const getTrainingCompliance: ToolHandler = async () => {
  return {
    compliant: 234,
    overdue: 12,
    upcoming: 45,
    overdueEmployees: [
      { id: "EMP007", name: "Jannik Sinner", training: "harassment", dueDate: "2025-01-15" },
    ],
  };
};

const getIncidentReports: ToolHandler = async () => {
  return {
    incidents: [
      { id: "INC-001", type: "safety", status: "closed", date: "2025-01-10" },
      { id: "INC-002", type: "harassment", status: "investigating", date: "2025-01-18" },
    ],
  };
};

const fileIncidentReport: ToolHandler = async (args) => {
  return {
    incidentId: generateId("INC-"),
    status: "submitted",
    type: args.type,
    assignedTo: "HR Manager",
  };
};

const fileWorkersCompClaim: ToolHandler = async (args) => {
  return {
    claimId: generateId("WC-"),
    status: "filed",
    employeeId: args.employeeId,
    incidentDate: args.incidentDate,
  };
};

const getLicenseExpiry: ToolHandler = async () => {
  return {
    licenses: [
      { employeeId: "EMP001", license: "CPA", expiry: "2025-06-30", daysRemaining: 145 },
      { employeeId: "EMP003", license: "PMP", expiry: "2025-03-15", daysRemaining: 38 },
    ],
  };
};

const updateLicense: ToolHandler = async (args) => {
  return { success: true, licenseType: args.licenseType, newExpiry: args.expiryDate };
};

const getBackgroundCheckStatus: ToolHandler = async (args) => {
  return {
    checks: [
      { subjectId: args.employeeId || args.candidateId, status: "completed", result: "clear" },
    ],
  };
};

const initiateBackgroundCheck: ToolHandler = async (args) => {
  return {
    checkId: generateId("BGC-"),
    subjectId: args.subjectId,
    checkType: args.checkType,
    estimatedCompletion: "5-7 business days",
  };
};

const getI9Status: ToolHandler = async () => {
  return {
    employees: [
      { id: "EMP001", status: "verified", completedDate: "2024-06-15" },
      { id: "EMP008", status: "pending", deadline: "2025-02-15" },
    ],
  };
};

// -------------------------------------------------------------------------
// BENEFITS handlers
// -------------------------------------------------------------------------

const enrollBenefits: ToolHandler = async (args) => {
  return {
    enrollmentId: generateId("ENR-"),
    effectiveDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    monthlyPremium: 450,
    confirmation: "sent",
  };
};

const updateDependents: ToolHandler = async (args) => {
  const dependents = args.dependents as Array<{ name: string; relationship: string; dob: string }>;
  return {
    updated: true,
    dependents,
    premiumChange: "+$150/month",
  };
};

const compareBenefitPlans: ToolHandler = async (args) => {
  const plans = [
    { name: "Basic", premium: 200, deductible: 2000, coverage: "80%", network: "standard" },
    { name: "Premium", premium: 400, deductible: 500, coverage: "90%", network: "extended" },
    { name: "Premium Plus", premium: 600, deductible: 0, coverage: "100%", network: "nationwide" },
  ];

  return {
    plans,
    recommendation: "Premium plan offers best value for most employees",
  };
};

const getBenefitsSummary: ToolHandler = async (args) => {
  return {
    health: { plan: "Premium", premium: 400, deductible: 500, coverage: "90%" },
    dental: { plan: "Basic", premium: 50, deductible: 100, coverage: "80%" },
    vision: { plan: "Standard", premium: 25, deductible: 50, coverage: "80%" },
    retirement: { contribution: "6%", match: "4%", vestedBalance: 45000 },
    totalMonthlyPremium: 475,
  };
};

const process401kChange: ToolHandler = async (args) => {
  return {
    updated: true,
    previousContribution: "4%",
    newContribution: `${args.newContribution}%`,
    effectiveDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    projectedMatch: "4%",
  };
};

const openEnrollmentStatus: ToolHandler = async () => {
  return {
    period: "2025 Open Enrollment",
    startDate: "2025-11-01",
    endDate: "2025-11-30",
    daysRemaining: 12,
    enrolled: 456,
    pending: 78,
  };
};

const getClaimStatus: ToolHandler = async (args) => {
  return {
    claims: [
      { id: "CLM-001", type: "medical", amount: 250, status: "approved", date: "2025-01-10" },
      { id: "CLM-002", type: "dental", amount: 80, status: "pending", date: "2025-01-20" },
    ],
  };
};

const submitClaim: ToolHandler = async (args) => {
  return {
    claimId: generateId("CLM-"),
    status: "submitted",
    amount: args.amount,
    estimatedProcessing: "7-10 business days",
  };
};

const getFSABalance: ToolHandler = async (args) => {
  return {
    balance: 1250,
    contributed: 2500,
    spent: 1250,
    pendingClaims: 150,
    deadline: "2025-03-15",
  };
};

const getHSAContributions: ToolHandler = async (args) => {
  return {
    ytdContributions: 3600,
    employerContributions: 500,
    balance: 8500,
    investments: { stocks: 4000, bonds: 2000, cash: 2500 },
  };
};

const updateHSAContribution: ToolHandler = async (args) => {
  return { success: true, newContribution: args.newContribution, effectiveDate: args.effectiveDate || "next pay period" };
};

const getWellnessPoints: ToolHandler = async (args) => {
  return {
    currentPoints: 750,
    pointsToReward: 250,
    activities: [
      { activity: "Annual physical", points: 200, completed: true },
      { activity: "Fitness challenge", points: 100, completed: true },
    ],
    availableRewards: ["$100 gift card", "Extra PTO day"],
  };
};

const logWellnessActivity: ToolHandler = async (args) => {
  return { success: true, activity: args.activity, pointsEarned: 50, newTotal: 800 };
};

const getLifeEventOptions: ToolHandler = async (args) => {
  return {
    eventType: args.eventType,
    eligibleChanges: ["Add/remove dependents", "Change coverage level", "Add/remove spouse"],
    deadline: "30 days from event",
    requiredDocuments: ["Marriage certificate", "Birth certificate"],
  };
};

// -------------------------------------------------------------------------
// ADMIN-ONLY handlers (always return error)
// -------------------------------------------------------------------------

const deleteEmployeeRecord: ToolHandler = async () => {
  return { error: "This action requires admin privileges" };
};

const overridePayroll: ToolHandler = async () => {
  return { error: "This action requires admin privileges" };
};

const accessAllRecords: ToolHandler = async () => {
  return { error: "This action requires admin privileges" };
};

const systemConfiguration: ToolHandler = async () => {
  return { error: "This action requires admin privileges" };
};

const getSystemLogs: ToolHandler = async () => {
  return { error: "This action requires admin privileges" };
};

const exportAuditLogs: ToolHandler = async () => {
  return { error: "This action requires admin privileges" };
};

const bulkImportEmployees: ToolHandler = async () => {
  return { error: "This action requires admin privileges" };
};

const manageUserRoles: ToolHandler = async () => {
  return { error: "This action requires admin privileges" };
};

const configureIntegration: ToolHandler = async () => {
  return { error: "This action requires admin privileges" };
};

// -------------------------------------------------------------------------
// REPORTING handlers
// -------------------------------------------------------------------------

const getHeadcountReport: ToolHandler = async (args) => {
  return {
    groupBy: args.groupBy || "department",
    asOfDate: args.asOfDate || new Date().toISOString().split("T")[0],
    data: [
      { group: "Engineering", headcount: 45 },
      { group: "Product", headcount: 12 },
      { group: "Sales", headcount: 30 },
      { group: "HR", headcount: 8 },
    ],
    total: 95,
  };
};

const getTurnoverReport: ToolHandler = async (args) => {
  return {
    period: `${args.startDate} to ${args.endDate}`,
    turnoverRate: 12.5,
    voluntaryTerminations: 8,
    involuntaryTerminations: 2,
    newHires: 15,
    netChange: 5,
  };
};

const getDiversityReport: ToolHandler = async () => {
  return {
    genderDistribution: { male: 55, female: 43, nonBinary: 2 },
    ethnicityDistribution: { white: 60, asian: 20, hispanic: 12, black: 5, other: 3 },
    leadershipDiversity: { female: 35, underrepresented: 25 },
  };
};

const getCompensationReport: ToolHandler = async () => {
  return {
    averageSalary: 95000,
    medianSalary: 85000,
    salaryRange: { min: 50000, max: 250000 },
    byDepartment: [
      { department: "Engineering", average: 120000 },
      { department: "Sales", average: 90000 },
    ],
  };
};

const getPerformanceReport: ToolHandler = async (args) => {
  return {
    reviewCycle: args.reviewCycle,
    distribution: { exceptional: 10, exceeds: 30, meets: 50, needsImprovement: 8, doesNotMeet: 2 },
    averageRating: 3.4,
    completionRate: 95,
  };
};

const getAbsenteeismReport: ToolHandler = async (args) => {
  return {
    period: `${args.startDate} to ${args.endDate}`,
    avgAbsenceRate: 3.2,
    totalAbsenceDays: 156,
    byType: { sick: 60, vacation: 80, personal: 16 },
  };
};

const getBenefitsUtilizationReport: ToolHandler = async (args) => {
  return {
    year: args.year,
    healthUtilization: 78,
    dentalUtilization: 65,
    visionUtilization: 45,
    retirement401k: 82,
    avgPremiumCost: 450,
  };
};

const getRecruitingReport: ToolHandler = async (args) => {
  return {
    period: `${args.startDate} to ${args.endDate}`,
    totalApplications: 450,
    interviewsScheduled: 120,
    offersMade: 25,
    offersAccepted: 20,
    timeToHire: "28 days",
  };
};

const getTrainingReport: ToolHandler = async (args) => {
  return {
    year: args.year,
    completionRate: 88,
    totalHoursCompleted: 2500,
    topCourses: ["Security Awareness", "Harassment Prevention", "Leadership Basics"],
    overdue: 15,
  };
};

const exportReport: ToolHandler = async (args) => {
  return {
    reportId: args.reportId,
    format: args.format,
    downloadUrl: `https://hr.company.com/reports/download/${args.reportId}.${args.format}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
};

// -------------------------------------------------------------------------
// LEARNING & DEVELOPMENT handlers
// -------------------------------------------------------------------------

const getCourses: ToolHandler = async () => {
  return {
    courses: [
      { id: "CRS-001", name: "Leadership Fundamentals", format: "online", duration: "4 hours", required: false },
      { id: "CRS-002", name: "Security Awareness", format: "online", duration: "1 hour", required: true },
      { id: "CRS-003", name: "Project Management Basics", format: "hybrid", duration: "8 hours", required: false },
    ],
  };
};

const enrollCourse: ToolHandler = async (args) => {
  return {
    enrollmentId: generateId("ENR-"),
    courseId: args.courseId,
    status: "enrolled",
    startDate: new Date().toISOString().split("T")[0],
  };
};

const getTrainingProgress: ToolHandler = async (args) => {
  return {
    employeeId: args.employeeId,
    inProgress: [
      { courseId: "CRS-001", progress: 60, deadline: "2025-03-15" },
    ],
    completed: [
      { courseId: "CRS-002", completedDate: "2025-01-10", score: 95 },
    ],
    required: 3,
    completedCount: 1,
  };
};

const completeTraining: ToolHandler = async (args) => {
  return {
    success: true,
    moduleId: args.moduleId,
    score: args.score,
    certificateUrl: `https://hr.company.com/certificates/${generateId("CERT-")}.pdf`,
  };
};

const getSkillGaps: ToolHandler = async (args) => {
  return {
    gaps: [
      { skill: "Cloud Architecture", current: 2, required: 4, priority: "high" },
      { skill: "Team Leadership", current: 3, required: 4, priority: "medium" },
    ],
    recommendedCourses: ["CRS-003", "CRS-005"],
  };
};

const recommendCourses: ToolHandler = async (args) => {
  return {
    recommendations: [
      { courseId: "CRS-004", name: "Advanced TypeScript", relevance: 95, reason: "Skill gap analysis" },
      { courseId: "CRS-005", name: "Technical Leadership", relevance: 88, reason: "Career path" },
    ],
  };
};

const createLearningPath: ToolHandler = async (args) => {
  return {
    pathId: generateId("PATH-"),
    name: args.name,
    courses: args.courseIds,
    estimatedDuration: "40 hours",
  };
};

const assignLearningPath: ToolHandler = async (args) => {
  return {
    success: true,
    employeeId: args.employeeId,
    pathId: args.pathId,
    deadline: args.deadline,
  };
};

const getTrainingBudget: ToolHandler = async () => {
  return {
    allocated: 5000,
    spent: 1500,
    remaining: 3500,
    pendingRequests: 800,
  };
};

const requestExternalTraining: ToolHandler = async (args) => {
  return {
    requestId: generateId("TRQ-"),
    status: "pending_approval",
    trainingName: args.trainingName,
    cost: args.cost,
    approver: "Direct Manager",
  };
};

// =============================================================================
// Export handlers map
// =============================================================================

export type ToolHandlerFn = (
  args: Record<string, unknown>
) => Promise<Record<string, unknown>>;

export const toolHandlers: Record<string, ToolHandler> = {
  // Employees (20)
  viewEmployee,
  listEmployees,
  addEmployee,
  updateEmployee,
  getOrgChart,
  searchEmployees,
  getEmployeeDocuments,
  terminateEmployee,
  getPerformanceReview,
  getEmployeeGoals,
  setEmployeeGoals,
  getEmployeeSkills,
  updateEmployeeSkills,
  getCertifications,
  getAttendanceRecord,
  recordAttendance,
  getDirectReports,
  transferEmployee,
  promoteEmployee,
  // Payroll (15)
  calculatePayroll,
  approvePayroll,
  generatePayslips,
  getPayrollHistory,
  adjustSalary,
  addBonus,
  getTaxReports,
  getDeductions,
  updateDeductions,
  submitExpense,
  approveExpense,
  getExpenseHistory,
  getBonusHistory,
  getPayrollSummary,
  // Time & PTO (20)
  listTimeOffRequests,
  viewTimesheet,
  approveTimesheet,
  requestPTO,
  approvePTO,
  getPTOBalance,
  getTeamCalendar,
  exportTimeReports,
  getHolidays,
  cancelPTORequest,
  getOvertimeHours,
  approveOvertime,
  getShiftSchedule,
  updateShiftSchedule,
  swapShift,
  getLeaveTypes,
  requestLeaveOfAbsence,
  getAbsenceHistory,
  getTeamAvailability,
  // Onboarding (15)
  startOnboarding,
  sendOfferLetter,
  createAccounts,
  scheduleOrientation,
  assignEquipment,
  assignMentor,
  getOnboardingStatus,
  completeOnboardingTask,
  getOnboardingChecklist,
  getOnboardingMetrics,
  getRampGoals,
  setRampGoals,
  scheduleWelcomeMeeting,
  requestBadge,
  // Recruiting (20)
  postJob,
  listCandidates,
  reviewApplication,
  scheduleInterview,
  submitInterviewFeedback,
  moveCandidate,
  sendRejection,
  getRecruitingMetrics,
  getJobPostings,
  closeJobPosting,
  reopenJobPosting,
  getCandidateScorecard,
  rescheduleInterview,
  cancelInterview,
  getReferrals,
  submitReferral,
  getInterviewAvailability,
  createTalentPool,
  addToTalentPool,
  // Compliance (15)
  generateEEOReport,
  runComplianceAudit,
  getAuditTrail,
  checkPolicyCompliance,
  updateHandbook,
  getTrainingCompliance,
  getIncidentReports,
  fileIncidentReport,
  fileWorkersCompClaim,
  getLicenseExpiry,
  updateLicense,
  getBackgroundCheckStatus,
  initiateBackgroundCheck,
  getI9Status,
  // Benefits (15)
  enrollBenefits,
  updateDependents,
  compareBenefitPlans,
  getBenefitsSummary,
  process401kChange,
  openEnrollmentStatus,
  getClaimStatus,
  submitClaim,
  getFSABalance,
  getHSAContributions,
  updateHSAContribution,
  getWellnessPoints,
  logWellnessActivity,
  getLifeEventOptions,
  // Admin-Only (10)
  deleteEmployeeRecord,
  overridePayroll,
  accessAllRecords,
  systemConfiguration,
  getSystemLogs,
  exportAuditLogs,
  bulkImportEmployees,
  manageUserRoles,
  configureIntegration,
  // Reporting (10)
  getHeadcountReport,
  getTurnoverReport,
  getDiversityReport,
  getCompensationReport,
  getPerformanceReport,
  getAbsenteeismReport,
  getBenefitsUtilizationReport,
  getRecruitingReport,
  getTrainingReport,
  exportReport,
  // Learning & Development (10)
  getCourses,
  enrollCourse,
  getTrainingProgress,
  completeTraining,
  getSkillGaps,
  recommendCourses,
  createLearningPath,
  assignLearningPath,
  getTrainingBudget,
  requestExternalTraining,
};
