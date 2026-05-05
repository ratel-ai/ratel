import type { Employee, TimeOffRequest, Stats } from "../types/hr";

const API_BASE = import.meta.env.VITE_API_BASE || "";

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Employees
export async function getEmployees(): Promise<{ employees: Employee[]; total: number }> {
  return fetchJSON("/api/employees");
}

export async function getEmployee(id: string): Promise<Employee> {
  return fetchJSON(`/api/employees/${id}`);
}

export async function createEmployee(
  data: Omit<Employee, "id" | "status"> & { status?: Employee["status"] }
): Promise<Employee> {
  return fetchJSON("/api/employees", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateEmployee(
  id: string,
  updates: Partial<Omit<Employee, "id">>
): Promise<Employee> {
  return fetchJSON(`/api/employees/${id}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
}

export async function deleteEmployee(id: string): Promise<Employee> {
  return fetchJSON(`/api/employees/${id}`, { method: "DELETE" });
}

// Time Off
export async function getTimeOffRequests(): Promise<{ requests: TimeOffRequest[]; total: number }> {
  return fetchJSON("/api/time-off");
}

export async function createTimeOffRequest(
  data: Omit<TimeOffRequest, "id" | "createdAt" | "status" | "approvedBy">
): Promise<TimeOffRequest> {
  return fetchJSON("/api/time-off", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateTimeOffStatus(
  id: string,
  status: "approved" | "rejected",
  approvedBy?: string
): Promise<TimeOffRequest> {
  return fetchJSON(`/api/time-off/${id}/status`, {
    method: "PUT",
    body: JSON.stringify({ status, approvedBy }),
  });
}

// Stats
export async function getStats(): Promise<Stats> {
  return fetchJSON("/api/stats");
}
