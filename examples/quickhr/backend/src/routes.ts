import { FastifyInstance } from "fastify";
import {
  employees,
  getEmployeeById,
  addEmployee,
  updateEmployee,
  type Employee,
} from "./data/employees.js";
import {
  timeOffRequests,
  getRequestById,
  createRequest,
  updateRequestStatus,
  type TimeOffRequest,
} from "./data/time-off.js";

export function registerRoutes(app: FastifyInstance): void {
  // GET /api/employees - list all (existing)
  app.get("/api/employees", async () => {
    return { employees, total: employees.length };
  });

  // GET /api/employees/:id - get single employee
  app.get<{ Params: { id: string } }>("/api/employees/:id", async (req, reply) => {
    const employee = getEmployeeById(req.params.id);
    if (!employee) {
      return reply.status(404).send({ error: "Employee not found" });
    }
    return employee;
  });

  // POST /api/employees - create employee
  app.post<{
    Body: {
      name: string;
      email: string;
      role: string;
      department: string;
      startDate: string;
      managerId?: string;
    };
  }>("/api/employees", async (req, reply) => {
    const { name, email, role, department, startDate, managerId } = req.body;
    if (!name || !email || !role || !department || !startDate) {
      return reply.status(400).send({ error: "Missing required fields" });
    }
    const newEmployee = addEmployee({
      name,
      email,
      role,
      department,
      startDate,
      managerId: managerId || null,
      status: "onboarding",
    });
    return reply.status(201).send(newEmployee);
  });

  // PUT /api/employees/:id - update employee
  app.put<{
    Params: { id: string };
    Body: Partial<Omit<Employee, "id">>;
  }>("/api/employees/:id", async (req, reply) => {
    const updated = updateEmployee(req.params.id, req.body);
    if (!updated) {
      return reply.status(404).send({ error: "Employee not found" });
    }
    return updated;
  });

  // DELETE /api/employees/:id - soft delete (set status to inactive)
  app.delete<{ Params: { id: string } }>("/api/employees/:id", async (req, reply) => {
    const updated = updateEmployee(req.params.id, { status: "inactive" });
    if (!updated) {
      return reply.status(404).send({ error: "Employee not found" });
    }
    return updated;
  });

  // GET /api/time-off - list all (existing)
  app.get("/api/time-off", async () => {
    return { requests: timeOffRequests, total: timeOffRequests.length };
  });

  // POST /api/time-off - create PTO request
  app.post<{
    Body: {
      employeeId: string;
      employeeName: string;
      type: "vacation" | "sick" | "personal";
      startDate: string;
      endDate: string;
      days: number;
      notes?: string;
    };
  }>("/api/time-off", async (req, reply) => {
    const { employeeId, employeeName, type, startDate, endDate, days, notes } = req.body;
    if (!employeeId || !employeeName || !type || !startDate || !endDate || !days) {
      return reply.status(400).send({ error: "Missing required fields" });
    }
    const newRequest = createRequest({
      employeeId,
      employeeName,
      type,
      startDate,
      endDate,
      days,
      notes,
      status: "pending",
    });
    return reply.status(201).send(newRequest);
  });

  // PUT /api/time-off/:id/status - approve/reject
  app.put<{
    Params: { id: string };
    Body: {
      status: "approved" | "rejected";
      approvedBy?: string;
    };
  }>("/api/time-off/:id/status", async (req, reply) => {
    const { status, approvedBy } = req.body;
    if (!["approved", "rejected"].includes(status)) {
      return reply.status(400).send({ error: "Invalid status" });
    }
    const request = getRequestById(req.params.id);
    if (!request) {
      return reply.status(404).send({ error: "Time-off request not found" });
    }
    const updated = updateRequestStatus(req.params.id, status, approvedBy);
    return updated;
  });

  // GET /api/stats (existing)
  app.get("/api/stats", async () => {
    const pendingRequests = timeOffRequests.filter((r) => r.status === "pending").length;
    return {
      totalEmployees: employees.length,
      pendingRequests,
      activeEmployees: employees.filter((e) => e.status === "active").length,
      onboardingEmployees: employees.filter((e) => e.status === "onboarding").length,
    };
  });
}
