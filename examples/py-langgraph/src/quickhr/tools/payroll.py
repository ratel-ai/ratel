from __future__ import annotations

import json

from langchain_core.tools import tool


@tool
async def calculate_payroll(period: str, department_id: str | None = None) -> str:
    """Calculate payroll for a specific pay period including base salary, bonuses, deductions"""
    return json.dumps({"period": period, "total_gross": 56250, "total_deductions": 14062.5, "total_net": 42187.5, "employee_count": 9})


@tool
async def approve_payroll(payroll_id: str, approver_id: str) -> str:
    """Approve calculated payroll for processing"""
    return json.dumps({"approved": True, "message": "Payroll approved, will process on next business day"})


@tool
async def generate_payslips(payroll_id: str, delivery_method: str) -> str:
    """Generate and distribute payslips to employees"""
    return json.dumps({"generated": 9, "delivered": 9, "failed": []})


@tool
async def get_payroll_history(
    employee_id: str | None = None,
    department_id: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> str:
    """View payroll history for an employee or department"""
    return json.dumps({"records": [
        {"period": "2025-01", "gross": 6250, "net": 4687.5, "deductions": 1562.5},
        {"period": "2024-12", "gross": 6250, "net": 4687.5, "deductions": 1562.5},
    ]})


@tool
async def adjust_salary(employee_id: str, new_salary: float, effective_date: str, reason: str) -> str:
    """Adjust employee salary (raise, promotion, correction)"""
    return json.dumps({"success": True, "previous_salary": 75000, "new_salary": new_salary, "effective_date": effective_date})


@tool
async def add_bonus(employee_id: str, amount: float, reason: str, pay_period: str) -> str:
    """Add a one-time bonus to an employee's next payroll"""
    return json.dumps({"amount": amount, "pay_period": pay_period, "message": f"Bonus will be included in {pay_period} payroll"})


@tool
async def get_tax_reports(year: int, report_type: str) -> str:
    """Generate tax reports for compliance (W-2, 1099, etc.)"""
    return json.dumps({"report_url": f"https://hr.company.com/reports/{report_type}-{year}.pdf", "employees_included": 9})


@tool
async def get_deductions(employee_id: str, period: str | None = None) -> str:
    """View employee payroll deductions (taxes, benefits, garnishments)"""
    return json.dumps({"deductions": [
        {"type": "Federal Tax", "amount": 1200},
        {"type": "State Tax", "amount": 400},
        {"type": "Health Insurance", "amount": 250},
        {"type": "401k", "amount": 375},
    ]})


@tool
async def update_deductions(employee_id: str, deductions: list[dict], effective_date: str | None = None) -> str:
    """Update employee payroll deductions"""
    return json.dumps({"success": True, "updated_deductions": len(deductions)})


@tool
async def submit_expense(employee_id: str, amount: float, category: str, description: str, receipt_url: str | None = None) -> str:
    """Submit an expense report for reimbursement"""
    return json.dumps({"status": "pending", "amount": amount})


@tool
async def approve_expense(expense_id: str, decision: str, reason: str | None = None) -> str:
    """Approve or reject an expense report"""
    return json.dumps({"success": True, "decision": decision})


@tool
async def get_expense_history(employee_id: str, status: str | None = None) -> str:
    """View expense report history for an employee"""
    return json.dumps({"expenses": [
        {"id": "EXP-001", "amount": 150, "category": "Travel", "status": "approved"},
        {"id": "EXP-002", "amount": 45, "category": "Meals", "status": "pending"},
    ]})


@tool
async def get_bonus_history(employee_id: str, start_date: str | None = None, end_date: str | None = None) -> str:
    """View bonus payment history for an employee"""
    return json.dumps({"bonuses": [
        {"date": "2024-12-15", "amount": 5000, "reason": "Year-end performance"},
        {"date": "2024-06-15", "amount": 2500, "reason": "Q2 achievement"},
    ]})


@tool
async def get_payroll_summary(period: str, department_id: str | None = None) -> str:
    """Get payroll summary and statistics for a period"""
    return json.dumps({"period": period, "total_gross": 450000, "total_net": 337500, "employee_count": 9, "average_salary": 75000})


ALL_PAYROLL_TOOLS = [
    calculate_payroll, approve_payroll, generate_payslips, get_payroll_history,
    adjust_salary, add_bonus, get_tax_reports, get_deductions, update_deductions,
    submit_expense, approve_expense, get_expense_history, get_bonus_history, get_payroll_summary,
]
