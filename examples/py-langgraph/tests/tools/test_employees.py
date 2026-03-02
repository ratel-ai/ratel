import json
import pytest

from quickhr.tools.employees import (
    view_employee,
    list_employees,
    add_employee,
    update_employee,
    get_org_chart,
    search_employees,
    get_employee_documents,
    terminate_employee,
    get_direct_reports,
    get_performance_review,
    promote_employee,
)


class TestViewEmployee:
    async def test_existing(self):
        result = await view_employee.ainvoke({"employee_id": "EMP005"})
        data = json.loads(result)
        assert data["name"] == "Luca Ferrari"
        assert data["role"] == "CTO"

    async def test_missing(self):
        result = await view_employee.ainvoke({"employee_id": "EMP999"})
        assert "not found" in result


class TestListEmployees:
    async def test_all(self):
        result = await list_employees.ainvoke({})
        data = json.loads(result)
        assert data["total"] == 10

    async def test_by_department(self):
        result = await list_employees.ainvoke({"department": "Engineering"})
        data = json.loads(result)
        assert data["total"] == 3

    async def test_by_status(self):
        result = await list_employees.ainvoke({"status": "onboarding"})
        data = json.loads(result)
        assert data["total"] == 1

    async def test_with_limit(self):
        result = await list_employees.ainvoke({"limit": 3})
        data = json.loads(result)
        assert len(data["employees"]) == 3


class TestAddEmployee:
    async def test_add(self):
        result = await add_employee.ainvoke({
            "name": "New Person",
            "email": "new@company.com",
            "role": "Intern",
            "department": "Engineering",
            "start_date": "2025-06-01",
        })
        data = json.loads(result)
        assert data["employee_id"] == "EMP011"
        assert data["message"] == "Employee record created"


class TestUpdateEmployee:
    async def test_update(self):
        result = await update_employee.ainvoke({
            "employee_id": "EMP001",
            "role": "Senior Engineer",
            "department": "Product",
        })
        data = json.loads(result)
        assert data["success"] is True

    async def test_missing(self):
        result = await update_employee.ainvoke({
            "employee_id": "EMP999",
            "role": "X",
        })
        assert "not found" in result


class TestGetOrgChart:
    async def test_full(self):
        result = await get_org_chart.ainvoke({})
        data = json.loads(result)
        assert len(data["nodes"]) == 10

    async def test_by_department(self):
        result = await get_org_chart.ainvoke({"department": "Engineering"})
        data = json.loads(result)
        assert all(n["department"] == "Engineering" for n in data["nodes"])


class TestSearchEmployees:
    async def test_by_name(self):
        result = await search_employees.ainvoke({"query": "sinner"})
        data = json.loads(result)
        assert data["count"] == 1
        assert data["results"][0]["name"] == "Jannik Sinner"

    async def test_by_role(self):
        result = await search_employees.ainvoke({"query": "manager"})
        data = json.loads(result)
        assert data["count"] >= 2


class TestGetEmployeeDocuments:
    async def test_returns_docs(self):
        result = await get_employee_documents.ainvoke({"employee_id": "EMP001"})
        data = json.loads(result)
        assert len(data["documents"]) == 2

    async def test_filter_by_type(self):
        result = await get_employee_documents.ainvoke({
            "employee_id": "EMP001",
            "doc_type": "contract",
        })
        data = json.loads(result)
        assert len(data["documents"]) == 1


class TestTerminateEmployee:
    async def test_terminate(self):
        result = await terminate_employee.ainvoke({
            "employee_id": "EMP001",
            "reason": "Resigned",
            "last_day": "2025-03-01",
            "termination_type": "voluntary",
        })
        data = json.loads(result)
        assert data["success"] is True

    async def test_missing(self):
        result = await terminate_employee.ainvoke({
            "employee_id": "EMP999",
            "reason": "X",
            "last_day": "2025-03-01",
            "termination_type": "voluntary",
        })
        assert "not found" in result


class TestGetDirectReports:
    async def test_with_reports(self):
        result = await get_direct_reports.ainvoke({"manager_id": "EMP005"})
        data = json.loads(result)
        assert data["count"] >= 4


class TestGetPerformanceReview:
    async def test_returns_reviews(self):
        result = await get_performance_review.ainvoke({"employee_id": "EMP001"})
        data = json.loads(result)
        assert "reviews" in data


class TestPromoteEmployee:
    async def test_promote(self):
        result = await promote_employee.ainvoke({
            "employee_id": "EMP001",
            "new_role": "Senior Engineer",
            "effective_date": "2025-04-01",
        })
        data = json.loads(result)
        assert data["success"] is True
        assert data["new_role"] == "Senior Engineer"
