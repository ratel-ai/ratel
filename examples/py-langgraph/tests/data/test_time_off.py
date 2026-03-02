from quickhr.data.time_off import (
    time_off_requests,
    pto_balances,
    get_request_by_id,
    get_requests_by_employee,
    get_requests_by_status,
    get_pto_balance,
    create_request,
    update_request_status,
)


class TestTimeOffData:
    def test_has_5_requests(self):
        assert len(time_off_requests) == 5

    def test_request_fields(self):
        req = time_off_requests[0]
        assert req["id"] == "PTO001"
        assert req["employee_id"] == "EMP006"
        assert req["type"] == "sick"
        assert req["status"] == "pending"

    def test_has_5_balances(self):
        assert len(pto_balances) == 5


class TestGetRequestById:
    def test_existing(self):
        req = get_request_by_id("PTO003")
        assert req is not None
        assert req["employee_name"] == "Carlos Alcaraz"

    def test_missing(self):
        assert get_request_by_id("PTO999") is None


class TestGetRequestsByEmployee:
    def test_with_results(self):
        result = get_requests_by_employee("EMP006")
        assert len(result) == 1
        assert result[0]["id"] == "PTO001"

    def test_no_results(self):
        assert get_requests_by_employee("EMP999") == []


class TestGetRequestsByStatus:
    def test_pending(self):
        result = get_requests_by_status("pending")
        assert len(result) == 2

    def test_approved(self):
        result = get_requests_by_status("approved")
        assert len(result) == 2


class TestGetPTOBalance:
    def test_existing(self):
        bal = get_pto_balance("EMP002")
        assert bal is not None
        assert bal["vacation"]["total"] == 20
        assert bal["sick"]["remaining"] == 8

    def test_missing(self):
        assert get_pto_balance("EMP999") is None


class TestCreateRequest:
    def test_creates_with_auto_id(self):
        req = create_request(
            employee_id="EMP001",
            employee_name="Marco Rossi",
            type="vacation",
            start_date="2025-06-01",
            end_date="2025-06-05",
            days=5,
            status="pending",
        )
        assert req["id"] == "PTO006"
        assert req["employee_id"] == "EMP001"
        assert "created_at" in req
        assert len(time_off_requests) == 6


class TestUpdateRequestStatus:
    def test_approve(self):
        req = update_request_status("PTO001", "approved", approved_by="EMP005")
        assert req is not None
        assert req["status"] == "approved"
        assert req["approved_by"] == "EMP005"

    def test_reject(self):
        req = update_request_status("PTO004", "rejected")
        assert req is not None
        assert req["status"] == "rejected"

    def test_missing(self):
        assert update_request_status("PTO999", "approved") is None
