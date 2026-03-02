from __future__ import annotations

from typing import TypedDict


class Employee(TypedDict):
    id: str
    name: str
    email: str
    role: str
    department: str
    start_date: str
    manager_id: str | None
    status: str  # "active" | "inactive" | "onboarding"


employees: list[Employee] = [
    {
        "id": "EMP001",
        "name": "Marco Rossi",
        "email": "marco.rossi@company.com",
        "role": "Software Engineer",
        "department": "Engineering",
        "start_date": "2025-02-15",
        "manager_id": "EMP003",
        "status": "onboarding",
    },
    {
        "id": "EMP002",
        "name": "Giulia Bianchi",
        "email": "giulia.bianchi@company.com",
        "role": "Product Manager",
        "department": "Product",
        "start_date": "2024-03-01",
        "manager_id": "EMP005",
        "status": "active",
    },
    {
        "id": "EMP003",
        "name": "Alessandro Romano",
        "email": "alessandro.romano@company.com",
        "role": "Engineering Manager",
        "department": "Engineering",
        "start_date": "2023-01-15",
        "manager_id": "EMP005",
        "status": "active",
    },
    {
        "id": "EMP004",
        "name": "Carlos Alcaraz",
        "email": "carlos.alcaraz@company.com",
        "role": "UX Designer",
        "department": "Design",
        "start_date": "2024-06-01",
        "manager_id": "EMP002",
        "status": "active",
    },
    {
        "id": "EMP005",
        "name": "Luca Ferrari",
        "email": "luca.ferrari@company.com",
        "role": "CTO",
        "department": "Executive",
        "start_date": "2022-01-01",
        "manager_id": None,
        "status": "active",
    },
    {
        "id": "EMP006",
        "name": "Roberto Stagi",
        "email": "roberto.stagi@company.com",
        "role": "HR Manager",
        "department": "HR",
        "start_date": "2023-06-01",
        "manager_id": "EMP005",
        "status": "active",
    },
    {
        "id": "EMP007",
        "name": "Jannik Sinner",
        "email": "jannik.sinner@company.com",
        "role": "Sales Rep",
        "department": "Sales",
        "start_date": "2024-01-15",
        "manager_id": "EMP008",
        "status": "active",
    },
    {
        "id": "EMP008",
        "name": "Francesca Gallo",
        "email": "francesca.gallo@company.com",
        "role": "Sales Director",
        "department": "Sales",
        "start_date": "2023-03-01",
        "manager_id": "EMP005",
        "status": "active",
    },
    {
        "id": "EMP009",
        "name": "Andrea Conti",
        "email": "andrea.conti@company.com",
        "role": "DevOps Engineer",
        "department": "Engineering",
        "start_date": "2024-09-01",
        "manager_id": "EMP003",
        "status": "active",
    },
    {
        "id": "EMP010",
        "name": "Laura Russo",
        "email": "laura.russo@company.com",
        "role": "Accountant",
        "department": "Finance",
        "start_date": "2024-04-01",
        "manager_id": "EMP005",
        "status": "active",
    },
]


def get_employee_by_id(employee_id: str) -> Employee | None:
    return next((e for e in employees if e["id"] == employee_id), None)


def get_employees_by_department(department: str) -> list[Employee]:
    return [e for e in employees if e["department"] == department]


def get_employees_by_status(status: str) -> list[Employee]:
    return [e for e in employees if e["status"] == status]


def add_employee(
    *,
    name: str,
    email: str,
    role: str,
    department: str,
    start_date: str,
    manager_id: str | None = None,
) -> Employee:
    new_id = f"EMP{len(employees) + 1:03d}"
    emp: Employee = {
        "id": new_id,
        "name": name,
        "email": email,
        "role": role,
        "department": department,
        "start_date": start_date,
        "manager_id": manager_id,
        "status": "onboarding",
    }
    employees.append(emp)
    return emp


def update_employee(employee_id: str, **updates: str) -> Employee | None:
    emp = get_employee_by_id(employee_id)
    if emp is None:
        return None
    emp.update(updates)  # type: ignore[typeddict-item]
    return emp
