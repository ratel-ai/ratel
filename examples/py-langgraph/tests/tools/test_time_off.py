import json
import pytest

from quickhr.tools.time_off import (
    list_time_off_requests,
    request_pto,
    approve_pto,
    get_pto_balance,
    get_team_calendar,
    cancel_pto_request,
    get_holidays,
    get_leave_types,
    view_timesheet,
    get_team_availability,
)


class TestListTimeOffRequests:
    async def test_all(self):
        result = await list_time_off_requests.ainvoke({})
        data = json.loads(result)
        assert data["total"] == 5

    async def test_by_status(self):
        result = await list_time_off_requests.ainvoke({"status": "pending"})
        data = json.loads(result)
        assert data["total"] == 2

    async def test_by_employee(self):
        result = await list_time_off_requests.ainvoke({"employee_id": "EMP006"})
        data = json.loads(result)
        assert data["total"] == 1


class TestRequestPTO:
    async def test_submit(self):
        result = await request_pto.ainvoke({
            "employee_id": "EMP002",
            "start_date": "2025-05-01",
            "end_date": "2025-05-05",
            "pto_type": "vacation",
        })
        data = json.loads(result)
        assert data["status"] == "pending"
        assert data["days_requested"] == 5


class TestApprovePTO:
    async def test_approve(self):
        result = await approve_pto.ainvoke({
            "request_id": "PTO001",
            "decision": "approve",
        })
        data = json.loads(result)
        assert data["new_status"] == "approved"

    async def test_deny(self):
        result = await approve_pto.ainvoke({
            "request_id": "PTO004",
            "decision": "deny",
        })
        data = json.loads(result)
        assert data["new_status"] == "rejected"


class TestGetPTOBalance:
    async def test_existing(self):
        result = await get_pto_balance.ainvoke({"employee_id": "EMP002"})
        data = json.loads(result)
        assert data["vacation"]["total"] == 20

    async def test_default_balance(self):
        result = await get_pto_balance.ainvoke({"employee_id": "EMP099"})
        data = json.loads(result)
        assert data["vacation"]["total"] == 15


class TestGetTeamCalendar:
    async def test_returns_days(self):
        result = await get_team_calendar.ainvoke({
            "team_id": "Engineering",
            "month": 3,
            "year": 2025,
        })
        data = json.loads(result)
        assert len(data["days"]) == 31


class TestCancelPTORequest:
    async def test_cancel(self):
        result = await cancel_pto_request.ainvoke({"request_id": "PTO001"})
        data = json.loads(result)
        assert data["success"] is True


class TestGetHolidays:
    async def test_returns_holidays(self):
        result = await get_holidays.ainvoke({"year": 2025})
        data = json.loads(result)
        assert len(data["holidays"]) >= 3


class TestGetLeaveTypes:
    async def test_returns_types(self):
        result = await get_leave_types.ainvoke({})
        data = json.loads(result)
        assert len(data["leave_types"]) >= 3


class TestViewTimesheet:
    async def test_returns_entries(self):
        result = await view_timesheet.ainvoke({
            "employee_id": "EMP001",
            "start_date": "2025-02-01",
            "end_date": "2025-02-07",
        })
        data = json.loads(result)
        assert "entries" in data
        assert "total_hours" in data


class TestGetTeamAvailability:
    async def test_returns_availability(self):
        result = await get_team_availability.ainvoke({
            "team_id": "Engineering",
            "start_date": "2025-03-01",
            "end_date": "2025-03-07",
        })
        data = json.loads(result)
        assert "availability" in data
