from __future__ import annotations

import json

from langchain_core.tools import tool

from quickhr.data.employees import (
    employees,
    get_employee_by_id,
    get_employees_by_department,
    get_employees_by_status,
    add_employee as add_employee_data,
    update_employee as update_employee_data,
)


@tool
async def view_employee(employee_id: str) -> str:
    """View detailed employee profile including role, department, start date, and contact info"""
    emp = get_employee_by_id(employee_id)
    if not emp:
        return f"Employee {employee_id} not found"
    return json.dumps(emp)


@tool
async def list_employees(
    department: str | None = None,
    status: str | None = None,
    limit: int | None = None,
) -> str:
    """List all employees with optional filters by department or status"""
    result = list(employees)
    if department:
        result = [e for e in result if e["department"].lower() == department.lower()]
    if status:
        result = [e for e in result if e["status"].lower() == status.lower()]
    if limit:
        result = result[:limit]
    return json.dumps({"employees": result, "total": len(result)})


@tool
async def add_employee(
    name: str,
    email: str,
    role: str,
    department: str,
    start_date: str,
    manager_id: str | None = None,
) -> str:
    """Add a new employee to the system (creates initial record, does not trigger onboarding)"""
    emp = add_employee_data(
        name=name,
        email=email,
        role=role,
        department=department,
        start_date=start_date,
        manager_id=manager_id,
    )
    return json.dumps({"employee_id": emp["id"], "message": "Employee record created"})


@tool
async def update_employee(
    employee_id: str,
    role: str | None = None,
    department: str | None = None,
    email: str | None = None,
) -> str:
    """Update employee information such as role, department, or contact details"""
    updates = {k: v for k, v in {"role": role, "department": department, "email": email}.items() if v is not None}
    updated = update_employee_data(employee_id, **updates)
    if not updated:
        return f"Employee {employee_id} not found"
    return json.dumps({"success": True, "updated": list(updates.keys())})


@tool
async def get_org_chart(department: str | None = None, manager_id: str | None = None) -> str:
    """Get organizational chart showing reporting structure"""
    nodes = [
        {
            "id": e["id"],
            "name": e["name"],
            "role": e["role"],
            "department": e["department"],
            "manager_id": e["manager_id"],
            "reports": [r["id"] for r in employees if r["manager_id"] == e["id"]],
        }
        for e in employees
    ]
    if department:
        nodes = [n for n in nodes if n["department"] == department]
    elif manager_id:
        nodes = [n for n in nodes if n["id"] == manager_id or n["manager_id"] == manager_id]
    return json.dumps({"nodes": nodes})


@tool
async def search_employees(query: str) -> str:
    """Search employees by name, email, or role"""
    q = query.lower()
    results = [
        e for e in employees
        if q in e["name"].lower() or q in e["email"].lower() or q in e["role"].lower()
    ]
    return json.dumps({"results": results, "count": len(results)})


@tool
async def get_employee_documents(employee_id: str, doc_type: str | None = None) -> str:
    """List documents associated with an employee (contracts, IDs, certifications)"""
    docs = [
        {"id": f"DOC-{employee_id}-1", "name": "Employment Contract", "type": "contract", "upload_date": "2024-01-15"},
        {"id": f"DOC-{employee_id}-2", "name": "ID Copy", "type": "id", "upload_date": "2024-01-15"},
    ]
    if doc_type:
        docs = [d for d in docs if d["type"] == doc_type]
    return json.dumps({"documents": docs})


@tool
async def terminate_employee(
    employee_id: str,
    reason: str,
    last_day: str,
    termination_type: str,
) -> str:
    """Initiate employee termination process (triggers offboarding workflow)"""
    emp = get_employee_by_id(employee_id)
    if not emp:
        return f"Employee {employee_id} not found"
    update_employee_data(employee_id, status="inactive")
    return json.dumps({
        "success": True,
        "message": "Termination initiated, offboarding workflow started",
    })


@tool
async def get_performance_review(employee_id: str, year: int | None = None) -> str:
    """Retrieve employee's performance review history and ratings"""
    return json.dumps({
        "employee_id": employee_id,
        "reviews": [
            {"year": 2025, "rating": 4, "cycle": "Q4", "feedback": "Excellent performance"},
            {"year": 2024, "rating": 3.5, "cycle": "Q4", "feedback": "Meets expectations"},
        ],
    })


@tool
async def get_employee_goals(employee_id: str, status: str | None = None) -> str:
    """Get employee's current goals and OKRs with progress tracking"""
    return json.dumps({
        "goals": [
            {"id": "G1", "title": "Complete project X", "status": "active", "progress": 75},
            {"id": "G2", "title": "Mentor new team member", "status": "active", "progress": 50},
        ],
    })


@tool
async def set_employee_goals(employee_id: str, goals: list[dict], quarter: str | None = None) -> str:
    """Set or update employee goals and OKRs"""
    return json.dumps({"success": True, "goals_set": len(goals)})


@tool
async def get_employee_skills(employee_id: str) -> str:
    """List employee skills, certifications, and proficiency levels"""
    return json.dumps({
        "skills": [
            {"name": "JavaScript", "proficiency": "expert"},
            {"name": "React", "proficiency": "advanced"},
            {"name": "TypeScript", "proficiency": "advanced"},
        ],
    })


@tool
async def update_employee_skills(employee_id: str, skills: list[dict]) -> str:
    """Update employee skill profile and proficiency levels"""
    return json.dumps({"success": True, "updated_skills": len(skills)})


@tool
async def get_certifications(employee_id: str, status: str | None = None) -> str:
    """Get employee certifications with expiration dates"""
    return json.dumps({
        "certifications": [
            {"name": "AWS Solutions Architect", "expiry": "2026-06-15", "status": "valid"},
            {"name": "PMP", "expiry": "2025-03-01", "status": "expiring_soon"},
        ],
    })


@tool
async def get_attendance_record(employee_id: str, start_date: str, end_date: str) -> str:
    """View employee attendance history and patterns"""
    return json.dumps({
        "records": [
            {"date": start_date, "status": "present", "hours_worked": 8},
            {"date": end_date, "status": "present", "hours_worked": 8},
        ],
        "summary": {"days_present": 20, "days_absent": 1, "avg_hours": 8.2},
    })


@tool
async def record_attendance(employee_id: str, attendance_type: str, timestamp: str | None = None) -> str:
    """Record employee attendance (clock in/out)"""
    return json.dumps({"success": True, "type": attendance_type})


@tool
async def get_direct_reports(manager_id: str) -> str:
    """List all direct reports for a manager"""
    reports = [e for e in employees if e["manager_id"] == manager_id]
    return json.dumps({"direct_reports": reports, "count": len(reports)})


@tool
async def transfer_employee(
    employee_id: str,
    new_department: str,
    effective_date: str,
    new_manager: str | None = None,
) -> str:
    """Transfer employee to different department or location"""
    return json.dumps({
        "success": True,
        "message": f"Transfer to {new_department} scheduled for {effective_date}",
    })


@tool
async def promote_employee(
    employee_id: str,
    new_role: str,
    effective_date: str,
    new_salary: float | None = None,
) -> str:
    """Promote employee to new role with updated compensation"""
    return json.dumps({
        "success": True,
        "new_role": new_role,
        "effective_date": effective_date,
    })


ALL_EMPLOYEE_TOOLS = [
    view_employee,
    list_employees,
    add_employee,
    update_employee,
    get_org_chart,
    search_employees,
    get_employee_documents,
    terminate_employee,
    get_performance_review,
    get_employee_goals,
    set_employee_goals,
    get_employee_skills,
    update_employee_skills,
    get_certifications,
    get_attendance_record,
    record_attendance,
    get_direct_reports,
    transfer_employee,
    promote_employee,
]
