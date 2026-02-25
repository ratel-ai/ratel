/**
 * Mock employee data for QuickHR demo
 */

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

export const employees: Employee[] = [
  {
    id: "EMP001",
    name: "Marco Rossi",
    email: "marco.rossi@company.com",
    role: "Software Engineer",
    department: "Engineering",
    startDate: "2025-02-15",
    managerId: "EMP003",
    status: "onboarding",
  },
  {
    id: "EMP002",
    name: "Giulia Bianchi",
    email: "giulia.bianchi@company.com",
    role: "Product Manager",
    department: "Product",
    startDate: "2024-03-01",
    managerId: "EMP005",
    status: "active",
  },
  {
    id: "EMP003",
    name: "Alessandro Romano",
    email: "alessandro.romano@company.com",
    role: "Engineering Manager",
    department: "Engineering",
    startDate: "2023-01-15",
    managerId: "EMP005",
    status: "active",
  },
  {
    id: "EMP004",
    name: "Carlos Alcaraz",
    email: "carlos.alcaraz@company.com",
    role: "UX Designer",
    department: "Design",
    startDate: "2024-06-01",
    managerId: "EMP002",
    status: "active",
  },
  {
    id: "EMP005",
    name: "Luca Ferrari",
    email: "luca.ferrari@company.com",
    role: "CTO",
    department: "Executive",
    startDate: "2022-01-01",
    managerId: null,
    status: "active",
  },
  {
    id: "EMP006",
    name: "Roberto Stagi",
    email: "roberto.stagi@company.com",
    role: "HR Manager",
    department: "HR",
    startDate: "2023-06-01",
    managerId: "EMP005",
    status: "active",
  },
  {
    id: "EMP007",
    name: "Jannik Sinner",
    email: "jannik.sinner@company.com",
    role: "Sales Rep",
    department: "Sales",
    startDate: "2024-01-15",
    managerId: "EMP008",
    status: "active",
  },
  {
    id: "EMP008",
    name: "Francesca Gallo",
    email: "francesca.gallo@company.com",
    role: "Sales Director",
    department: "Sales",
    startDate: "2023-03-01",
    managerId: "EMP005",
    status: "active",
  },
  {
    id: "EMP009",
    name: "Andrea Conti",
    email: "andrea.conti@company.com",
    role: "DevOps Engineer",
    department: "Engineering",
    startDate: "2024-09-01",
    managerId: "EMP003",
    status: "active",
  },
  {
    id: "EMP010",
    name: "Laura Russo",
    email: "laura.russo@company.com",
    role: "Accountant",
    department: "Finance",
    startDate: "2024-04-01",
    managerId: "EMP005",
    status: "active",
  },
];

// Helper functions for data manipulation
export function getEmployeeById(id: string): Employee | undefined {
  return employees.find((e) => e.id === id);
}

export function getEmployeesByDepartment(department: string): Employee[] {
  return employees.filter((e) => e.department === department);
}

export function getEmployeesByStatus(
  status: Employee["status"]
): Employee[] {
  return employees.filter((e) => e.status === status);
}

export function addEmployee(employee: Omit<Employee, "id">): Employee {
  const newId = `EMP${String(employees.length + 1).padStart(3, "0")}`;
  const newEmployee = { ...employee, id: newId };
  employees.push(newEmployee);
  return newEmployee;
}

export function updateEmployee(
  id: string,
  updates: Partial<Employee>
): Employee | undefined {
  const index = employees.findIndex((e) => e.id === id);
  if (index === -1) return undefined;
  employees[index] = { ...employees[index], ...updates };
  return employees[index];
}
