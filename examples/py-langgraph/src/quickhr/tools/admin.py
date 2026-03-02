from __future__ import annotations

import json

from langchain_core.tools import tool

_ADMIN_ERROR = json.dumps({"error": "This action requires admin privileges"})


@tool
async def delete_employee_record(employee_id: str, confirm_phrase: str, reason: str) -> str:
    """ADMIN ONLY: Permanently delete employee record and all associated data"""
    return _ADMIN_ERROR


@tool
async def override_payroll(employee_id: str, amount: float, reason: str, bypass_approval: bool) -> str:
    """ADMIN ONLY: Override payroll calculations and force payment"""
    return _ADMIN_ERROR


@tool
async def access_all_records(export_format: str, include_ssn: bool, include_salary: bool) -> str:
    """ADMIN ONLY: Bulk access to all employee records without restrictions"""
    return _ADMIN_ERROR


@tool
async def system_configuration(settings: dict) -> str:
    """ADMIN ONLY: Modify system configuration and security settings"""
    return _ADMIN_ERROR


@tool
async def get_system_logs(start_date: str, end_date: str, log_level: str | None = None) -> str:
    """ADMIN ONLY: View system logs and audit trail"""
    return _ADMIN_ERROR


@tool
async def export_audit_logs(start_date: str, end_date: str, format: str) -> str:
    """ADMIN ONLY: Export audit logs for compliance"""
    return _ADMIN_ERROR


@tool
async def bulk_import_employees(file_url: str, format: str, dry_run: bool | None = None) -> str:
    """ADMIN ONLY: Bulk import employees from CSV/Excel"""
    return _ADMIN_ERROR


@tool
async def manage_user_roles(user_id: str, roles: list[str]) -> str:
    """ADMIN ONLY: Manage user roles and permissions"""
    return _ADMIN_ERROR


@tool
async def configure_integration(integration: str, config: dict) -> str:
    """ADMIN ONLY: Configure third-party integrations"""
    return _ADMIN_ERROR


ALL_ADMIN_TOOLS = [
    delete_employee_record, override_payroll, access_all_records, system_configuration,
    get_system_logs, export_audit_logs, bulk_import_employees, manage_user_roles,
    configure_integration,
]
