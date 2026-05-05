/**
 * Mock time-off/PTO request data for QuickHR demo
 */

export interface TimeOffRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  type: "vacation" | "sick" | "personal";
  startDate: string;
  endDate: string;
  days: number;
  status: "pending" | "approved" | "rejected";
  notes?: string;
  approvedBy?: string;
  createdAt: string;
}

export const timeOffRequests: TimeOffRequest[] = [
  {
    id: "PTO001",
    employeeId: "EMP006",
    employeeName: "Roberto Stagi",
    type: "sick",
    startDate: "2025-02-10",
    endDate: "2025-02-15",
    days: 6,
    status: "pending",
    notes: "Flu recovery",
    createdAt: "2025-02-05",
  },
  {
    id: "PTO002",
    employeeId: "EMP007",
    employeeName: "Jannik Sinner",
    type: "sick",
    startDate: "2025-01-20",
    endDate: "2025-01-26",
    days: 7,
    status: "rejected",
    notes: "Australian Open conflict",
    createdAt: "2025-01-15",
  },
  {
    id: "PTO003",
    employeeId: "EMP004",
    employeeName: "Carlos Alcaraz",
    type: "vacation",
    startDate: "2025-03-01",
    endDate: "2025-03-14",
    days: 14,
    status: "approved",
    notes: "Spring break vacation",
    approvedBy: "EMP002",
    createdAt: "2025-02-01",
  },
  {
    id: "PTO004",
    employeeId: "EMP002",
    employeeName: "Giulia Bianchi",
    type: "personal",
    startDate: "2025-02-20",
    endDate: "2025-02-21",
    days: 2,
    status: "pending",
    notes: "Family event",
    createdAt: "2025-02-04",
  },
  {
    id: "PTO005",
    employeeId: "EMP009",
    employeeName: "Andrea Conti",
    type: "vacation",
    startDate: "2025-04-10",
    endDate: "2025-04-17",
    days: 8,
    status: "approved",
    notes: "Easter holiday",
    approvedBy: "EMP003",
    createdAt: "2025-01-28",
  },
];

// PTO balances per employee
export interface PTOBalance {
  employeeId: string;
  vacation: { used: number; remaining: number; total: number };
  sick: { used: number; remaining: number; total: number };
  personal: { used: number; remaining: number; total: number };
}

export const ptoBalances: PTOBalance[] = [
  {
    employeeId: "EMP001",
    vacation: { used: 0, remaining: 15, total: 15 },
    sick: { used: 0, remaining: 10, total: 10 },
    personal: { used: 0, remaining: 3, total: 3 },
  },
  {
    employeeId: "EMP002",
    vacation: { used: 5, remaining: 15, total: 20 },
    sick: { used: 2, remaining: 8, total: 10 },
    personal: { used: 0, remaining: 3, total: 3 },
  },
  {
    employeeId: "EMP003",
    vacation: { used: 8, remaining: 17, total: 25 },
    sick: { used: 3, remaining: 7, total: 10 },
    personal: { used: 1, remaining: 4, total: 5 },
  },
  {
    employeeId: "EMP004",
    vacation: { used: 14, remaining: 6, total: 20 },
    sick: { used: 0, remaining: 10, total: 10 },
    personal: { used: 2, remaining: 1, total: 3 },
  },
  {
    employeeId: "EMP005",
    vacation: { used: 10, remaining: 20, total: 30 },
    sick: { used: 0, remaining: 10, total: 10 },
    personal: { used: 0, remaining: 5, total: 5 },
  },
];

// Helper functions
export function getRequestById(id: string): TimeOffRequest | undefined {
  return timeOffRequests.find((r) => r.id === id);
}

export function getRequestsByEmployee(employeeId: string): TimeOffRequest[] {
  return timeOffRequests.filter((r) => r.employeeId === employeeId);
}

export function getRequestsByStatus(
  status: TimeOffRequest["status"]
): TimeOffRequest[] {
  return timeOffRequests.filter((r) => r.status === status);
}

export function getPTOBalance(employeeId: string): PTOBalance | undefined {
  return ptoBalances.find((b) => b.employeeId === employeeId);
}

export function createRequest(
  request: Omit<TimeOffRequest, "id" | "createdAt">
): TimeOffRequest {
  const newId = `PTO${String(timeOffRequests.length + 1).padStart(3, "0")}`;
  const newRequest: TimeOffRequest = {
    ...request,
    id: newId,
    createdAt: new Date().toISOString().split("T")[0],
  };
  timeOffRequests.push(newRequest);
  return newRequest;
}

export function updateRequestStatus(
  id: string,
  status: TimeOffRequest["status"],
  approvedBy?: string
): TimeOffRequest | undefined {
  const request = timeOffRequests.find((r) => r.id === id);
  if (!request) return undefined;
  request.status = status;
  if (approvedBy) request.approvedBy = approvedBy;
  return request;
}
