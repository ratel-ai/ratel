from __future__ import annotations

import json
from calendar import monthrange

from langchain_core.tools import tool

from quickhr.data.employees import get_employee_by_id
from quickhr.data.time_off import (
    time_off_requests,
    get_request_by_id,
    get_requests_by_employee,
    get_pto_balance as get_pto_balance_data,
    create_request,
    update_request_status,
)


@tool
async def list_time_off_requests(
    status: str | None = None,
    employee_id: str | None = None,
) -> str:
    """List all time off/PTO requests with optional filters by status or employee"""
    requests = list(time_off_requests)
    if status:
        requests = [r for r in requests if r["status"] == status]
    if employee_id:
        requests = [r for r in requests if r["employee_id"] == employee_id]
    return json.dumps({"requests": requests, "total": len(requests)})


@tool
async def request_pto(
    employee_id: str,
    start_date: str,
    end_date: str,
    pto_type: str,
    notes: str | None = None,
) -> str:
    """Submit a PTO (paid time off) request for an employee"""
    emp = get_employee_by_id(employee_id)
    from datetime import date as dt_date
    d1 = dt_date.fromisoformat(start_date)
    d2 = dt_date.fromisoformat(end_date)
    days = (d2 - d1).days + 1

    req = create_request(
        employee_id=employee_id,
        employee_name=emp["name"] if emp else "Unknown",
        type=pto_type,
        start_date=start_date,
        end_date=end_date,
        days=days,
        status="pending",
        notes=notes,
    )
    return json.dumps({
        "request_id": req["id"],
        "status": "pending",
        "days_requested": days,
        "message": "PTO request submitted for manager approval",
    })


@tool
async def approve_pto(request_id: str, decision: str, reason: str | None = None) -> str:
    """Approve or deny a pending PTO request"""
    new_status = "approved" if decision == "approve" else "rejected"
    update_request_status(request_id, new_status)
    return json.dumps({
        "success": True,
        "new_status": new_status,
        "message": "PTO approved" if decision == "approve" else "PTO denied",
    })


@tool
async def get_pto_balance(employee_id: str) -> str:
    """Check remaining PTO balance for an employee"""
    balance = get_pto_balance_data(employee_id)
    if not balance:
        return json.dumps({
            "vacation": {"used": 0, "remaining": 15, "total": 15},
            "sick": {"used": 0, "remaining": 10, "total": 10},
            "personal": {"used": 0, "remaining": 3, "total": 3},
        })
    return json.dumps({
        "vacation": balance["vacation"],
        "sick": balance["sick"],
        "personal": balance["personal"],
    })


@tool
async def get_team_calendar(team_id: str, month: int, year: int) -> str:
    """View team availability calendar showing PTO and holidays"""
    _, days_in_month = monthrange(year, month)
    days = []
    for i in range(1, days_in_month + 1):
        date_str = f"{year}-{month:02d}-{i:02d}"
        out = [
            r["employee_name"]
            for r in time_off_requests
            if r.get("start_date", "") <= date_str <= r.get("end_date", "")
            and r.get("status") == "approved"
        ]
        days.append({"date": date_str, "out_of_office": out, "holidays": []})
    return json.dumps({"days": days})


@tool
async def view_timesheet(employee_id: str, start_date: str, end_date: str) -> str:
    """View employee timesheet for a specific period"""
    entries = [
        {"date": start_date, "hours_worked": 8, "project": "Project Alpha", "status": "approved"},
        {"date": end_date, "hours_worked": 8, "project": "Project Alpha", "status": "pending"},
    ]
    return json.dumps({
        "entries": entries,
        "total_hours": sum(e["hours_worked"] for e in entries),
    })


@tool
async def approve_timesheet(timesheet_id: str, approver_id: str) -> str:
    """Approve an employee's submitted timesheet"""
    return json.dumps({"approved": True, "hours_approved": 40, "message": "Timesheet approved"})


@tool
async def cancel_pto_request(request_id: str, reason: str | None = None) -> str:
    """Cancel a pending or approved PTO request"""
    return json.dumps({"success": True, "request_id": request_id, "status": "cancelled"})


@tool
async def get_holidays(year: int, region: str | None = None) -> str:
    """Get company holidays for a specific year"""
    return json.dumps({
        "year": year,
        "holidays": [
            {"date": f"{year}-01-01", "name": "New Year's Day"},
            {"date": f"{year}-07-04", "name": "Independence Day"},
            {"date": f"{year}-12-25", "name": "Christmas Day"},
        ],
    })


@tool
async def get_overtime_hours(employee_id: str, start_date: str, end_date: str) -> str:
    """View overtime hours worked by employee"""
    return json.dumps({
        "overtime_hours": [
            {"week": "2025-01-06", "hours": 5, "approved": True},
            {"week": "2025-01-13", "hours": 3, "approved": False},
        ],
        "total_hours": 8,
    })


@tool
async def approve_overtime(overtime_id: str, approver_id: str) -> str:
    """Approve overtime hours for an employee"""
    return json.dumps({"success": True, "overtime_id": overtime_id, "status": "approved"})


@tool
async def get_shift_schedule(employee_id: str, week_of: str) -> str:
    """View employee shift schedule"""
    return json.dumps({
        "shifts": [
            {"date": week_of, "start": "09:00", "end": "17:00"},
        ],
    })


@tool
async def update_shift_schedule(employee_id: str, shifts: list[dict]) -> str:
    """Update employee shift schedule"""
    return json.dumps({"success": True, "shifts_updated": len(shifts)})


@tool
async def swap_shift(requester_id: str, target_id: str, shift_date: str) -> str:
    """Request or approve a shift swap between employees"""
    return json.dumps({"status": "pending_approval", "requester_id": requester_id, "target_id": target_id})


@tool
async def get_leave_types() -> str:
    """Get available leave types and their policies"""
    return json.dumps({
        "leave_types": [
            {"type": "vacation", "accrual_rate": "1.25 days/month", "max_carryover": 5},
            {"type": "sick", "accrual_rate": "0.83 days/month", "max_carryover": 0},
            {"type": "personal", "accrual_rate": "3 days/year", "max_carryover": 0},
            {"type": "parental", "duration": "12-16 weeks", "accrual_rate": "N/A"},
        ],
    })


@tool
async def request_leave_of_absence(
    employee_id: str,
    leave_type: str,
    start_date: str,
    end_date: str | None = None,
    reason: str | None = None,
) -> str:
    """Request extended leave of absence (FMLA, personal, etc.)"""
    return json.dumps({"status": "pending", "leave_type": leave_type, "start_date": start_date})


@tool
async def get_absence_history(employee_id: str, year: int | None = None) -> str:
    """View all absences for an employee"""
    return json.dumps({
        "absences": [
            {"type": "vacation", "start_date": "2025-01-06", "end_date": "2025-01-10", "days": 5},
            {"type": "sick", "start_date": "2025-01-20", "end_date": "2025-01-20", "days": 1},
        ],
        "total_days": 6,
    })


@tool
async def get_team_availability(team_id: str, start_date: str, end_date: str) -> str:
    """Check team availability for a specific date range"""
    return json.dumps({
        "availability": [
            {"date": start_date, "available": 8, "out_of_office": 2},
            {"date": end_date, "available": 10, "out_of_office": 0},
        ],
    })


@tool
async def export_time_reports(start_date: str, end_date: str, format: str, group_by: str | None = None) -> str:
    """Export time tracking reports for billing or analysis"""
    return json.dumps({"report_url": f"https://hr.company.com/time-reports/{format}/export", "record_count": 200})


ALL_TIME_OFF_TOOLS = [
    list_time_off_requests,
    view_timesheet,
    approve_timesheet,
    request_pto,
    approve_pto,
    get_pto_balance,
    get_team_calendar,
    export_time_reports,
    get_holidays,
    cancel_pto_request,
    get_overtime_hours,
    approve_overtime,
    get_shift_schedule,
    update_shift_schedule,
    swap_shift,
    get_leave_types,
    request_leave_of_absence,
    get_absence_history,
    get_team_availability,
]
