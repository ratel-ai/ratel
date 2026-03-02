from quickhr.data.employees import (
    Employee,
    employees,
    get_employee_by_id,
    get_employees_by_department,
    get_employees_by_status,
    add_employee,
    update_employee,
)


class TestEmployeeData:
    def test_employees_has_10_records(self):
        assert len(employees) == 10

    def test_employee_has_expected_fields(self):
        emp = employees[0]
        assert emp["id"] == "EMP001"
        assert emp["name"] == "Marco Rossi"
        assert emp["email"] == "marco.rossi@company.com"
        assert emp["role"] == "Software Engineer"
        assert emp["department"] == "Engineering"
        assert emp["start_date"] == "2025-02-15"
        assert emp["manager_id"] == "EMP003"
        assert emp["status"] == "onboarding"


class TestGetEmployeeById:
    def test_existing(self):
        emp = get_employee_by_id("EMP005")
        assert emp is not None
        assert emp["name"] == "Luca Ferrari"

    def test_missing(self):
        assert get_employee_by_id("EMP999") is None


class TestGetEmployeesByDepartment:
    def test_engineering(self):
        result = get_employees_by_department("Engineering")
        assert len(result) == 3
        assert all(e["department"] == "Engineering" for e in result)

    def test_empty_department(self):
        assert get_employees_by_department("Nonexistent") == []


class TestGetEmployeesByStatus:
    def test_active(self):
        result = get_employees_by_status("active")
        assert len(result) == 9
        assert all(e["status"] == "active" for e in result)

    def test_onboarding(self):
        result = get_employees_by_status("onboarding")
        assert len(result) == 1
        assert result[0]["id"] == "EMP001"


class TestAddEmployee:
    def test_add_creates_new_id(self):
        new = add_employee(
            name="Test User",
            email="test@company.com",
            role="Tester",
            department="QA",
            start_date="2025-06-01",
        )
        assert new["id"] == "EMP011"
        assert new["name"] == "Test User"
        assert new["status"] == "onboarding"
        assert new["manager_id"] is None
        assert len(employees) == 11

    def test_add_with_manager(self):
        new = add_employee(
            name="Another User",
            email="another@company.com",
            role="Dev",
            department="Engineering",
            start_date="2025-07-01",
            manager_id="EMP003",
        )
        assert new["manager_id"] == "EMP003"


class TestUpdateEmployee:
    def test_update_fields(self):
        updated = update_employee("EMP001", role="Senior Engineer", department="Product")
        assert updated is not None
        assert updated["role"] == "Senior Engineer"
        assert updated["department"] == "Product"
        # original name unchanged
        assert updated["name"] == "Marco Rossi"

    def test_update_missing(self):
        assert update_employee("EMP999", role="X") is None
