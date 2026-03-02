from __future__ import annotations

from datetime import date
from typing import TypedDict


class LeaveBalance(TypedDict):
    used: int
    remaining: int
    total: int


class PTOBalance(TypedDict):
    employee_id: str
    vacation: LeaveBalance
    sick: LeaveBalance
    personal: LeaveBalance


class TimeOffRequest(TypedDict, total=False):
    id: str
    employee_id: str
    employee_name: str
    type: str  # "vacation" | "sick" | "personal"
    start_date: str
    end_date: str
    days: int
    status: str  # "pending" | "approved" | "rejected"
    notes: str
    approved_by: str
    created_at: str


time_off_requests: list[TimeOffRequest] = [
    {
        "id": "PTO001",
        "employee_id": "EMP006",
        "employee_name": "Roberto Stagi",
        "type": "sick",
        "start_date": "2025-02-10",
        "end_date": "2025-02-15",
        "days": 6,
        "status": "pending",
        "notes": "Flu recovery",
        "created_at": "2025-02-05",
    },
    {
        "id": "PTO002",
        "employee_id": "EMP007",
        "employee_name": "Jannik Sinner",
        "type": "sick",
        "start_date": "2025-01-20",
        "end_date": "2025-01-26",
        "days": 7,
        "status": "rejected",
        "notes": "Australian Open conflict",
        "created_at": "2025-01-15",
    },
    {
        "id": "PTO003",
        "employee_id": "EMP004",
        "employee_name": "Carlos Alcaraz",
        "type": "vacation",
        "start_date": "2025-03-01",
        "end_date": "2025-03-14",
        "days": 14,
        "status": "approved",
        "notes": "Spring break vacation",
        "approved_by": "EMP002",
        "created_at": "2025-02-01",
    },
    {
        "id": "PTO004",
        "employee_id": "EMP002",
        "employee_name": "Giulia Bianchi",
        "type": "personal",
        "start_date": "2025-02-20",
        "end_date": "2025-02-21",
        "days": 2,
        "status": "pending",
        "notes": "Family event",
        "created_at": "2025-02-04",
    },
    {
        "id": "PTO005",
        "employee_id": "EMP009",
        "employee_name": "Andrea Conti",
        "type": "vacation",
        "start_date": "2025-04-10",
        "end_date": "2025-04-17",
        "days": 8,
        "status": "approved",
        "notes": "Easter holiday",
        "approved_by": "EMP003",
        "created_at": "2025-01-28",
    },
]

pto_balances: list[PTOBalance] = [
    {
        "employee_id": "EMP001",
        "vacation": {"used": 0, "remaining": 15, "total": 15},
        "sick": {"used": 0, "remaining": 10, "total": 10},
        "personal": {"used": 0, "remaining": 3, "total": 3},
    },
    {
        "employee_id": "EMP002",
        "vacation": {"used": 5, "remaining": 15, "total": 20},
        "sick": {"used": 2, "remaining": 8, "total": 10},
        "personal": {"used": 0, "remaining": 3, "total": 3},
    },
    {
        "employee_id": "EMP003",
        "vacation": {"used": 8, "remaining": 17, "total": 25},
        "sick": {"used": 3, "remaining": 7, "total": 10},
        "personal": {"used": 1, "remaining": 4, "total": 5},
    },
    {
        "employee_id": "EMP004",
        "vacation": {"used": 14, "remaining": 6, "total": 20},
        "sick": {"used": 0, "remaining": 10, "total": 10},
        "personal": {"used": 2, "remaining": 1, "total": 3},
    },
    {
        "employee_id": "EMP005",
        "vacation": {"used": 10, "remaining": 20, "total": 30},
        "sick": {"used": 0, "remaining": 10, "total": 10},
        "personal": {"used": 0, "remaining": 5, "total": 5},
    },
]


def get_request_by_id(request_id: str) -> TimeOffRequest | None:
    return next((r for r in time_off_requests if r["id"] == request_id), None)


def get_requests_by_employee(employee_id: str) -> list[TimeOffRequest]:
    return [r for r in time_off_requests if r["employee_id"] == employee_id]


def get_requests_by_status(status: str) -> list[TimeOffRequest]:
    return [r for r in time_off_requests if r["status"] == status]


def get_pto_balance(employee_id: str) -> PTOBalance | None:
    return next((b for b in pto_balances if b["employee_id"] == employee_id), None)


def create_request(
    *,
    employee_id: str,
    employee_name: str,
    type: str,
    start_date: str,
    end_date: str,
    days: int,
    status: str = "pending",
    notes: str | None = None,
) -> TimeOffRequest:
    new_id = f"PTO{len(time_off_requests) + 1:03d}"
    req: TimeOffRequest = {
        "id": new_id,
        "employee_id": employee_id,
        "employee_name": employee_name,
        "type": type,
        "start_date": start_date,
        "end_date": end_date,
        "days": days,
        "status": status,
        "created_at": date.today().isoformat(),
    }
    if notes:
        req["notes"] = notes
    time_off_requests.append(req)
    return req


def update_request_status(
    request_id: str,
    status: str,
    approved_by: str | None = None,
) -> TimeOffRequest | None:
    req = get_request_by_id(request_id)
    if req is None:
        return None
    req["status"] = status
    if approved_by:
        req["approved_by"] = approved_by
    return req
