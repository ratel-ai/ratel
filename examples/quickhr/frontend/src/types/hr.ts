export interface Employee {
  id: string;
  name: string;
  email: string;
  role: string;
  department: string;
  startDate: string;
  managerId: string | null;
  status: "active" | "inactive" | "onboarding";
}

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

export interface Stats {
  totalEmployees: number;
  pendingRequests: number;
  activeEmployees: number;
  onboardingEmployees: number;
}
