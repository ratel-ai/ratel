import copy

import pytest

from quickhr.data.employees import employees
from quickhr.data.time_off import time_off_requests, pto_balances


@pytest.fixture(autouse=True)
def reset_data():
    """Reset mutable mock data between tests."""
    original_employees = copy.deepcopy(employees)
    original_requests = copy.deepcopy(time_off_requests)
    original_balances = copy.deepcopy(pto_balances)
    yield
    employees.clear()
    employees.extend(original_employees)
    time_off_requests.clear()
    time_off_requests.extend(original_requests)
    pto_balances.clear()
    pto_balances.extend(original_balances)
