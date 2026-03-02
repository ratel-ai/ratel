from __future__ import annotations

import json

from langchain_core.tools import tool


@tool
async def enroll_benefits(employee_id: str, plans: dict) -> str:
    """Enroll employee in benefits package"""
    return json.dumps({"effective_date": "2025-04-01", "monthly_premium": 450, "confirmation": "sent"})


@tool
async def update_dependents(employee_id: str, dependents: list[dict]) -> str:
    """Add or update dependents for benefits coverage"""
    return json.dumps({"updated": True, "premium_change": "+$150/month"})


@tool
async def compare_benefit_plans(plan_type: str, employee_id: str | None = None) -> str:
    """Compare available benefit plans with costs and coverage"""
    return json.dumps({"plans": [
        {"name": "Basic", "premium": 200, "deductible": 2000, "coverage": "80%"},
        {"name": "Premium", "premium": 400, "deductible": 500, "coverage": "90%"},
        {"name": "Premium Plus", "premium": 600, "deductible": 0, "coverage": "100%"},
    ], "recommendation": "Premium plan offers best value"})


@tool
async def get_benefits_summary(employee_id: str) -> str:
    """Get summary of employee's current benefits enrollment"""
    return json.dumps({"health": {"plan": "Premium", "premium": 400}, "dental": {"plan": "Basic", "premium": 50},
                        "retirement": {"contribution": "6%", "match": "4%"}, "total_monthly_premium": 475})


@tool
async def process_401k_change(employee_id: str, new_contribution: float, investment_changes: dict | None = None) -> str:
    """Process changes to 401k contribution"""
    return json.dumps({"updated": True, "new_contribution": f"{new_contribution}%", "projected_match": "4%"})


@tool
async def open_enrollment_status() -> str:
    """Check open enrollment period status and deadlines"""
    return json.dumps({"period": "2025 Open Enrollment", "start_date": "2025-11-01", "end_date": "2025-11-30",
                        "days_remaining": 12, "enrolled": 456, "pending": 78})


@tool
async def get_claim_status(employee_id: str, claim_id: str | None = None) -> str:
    """Check status of insurance claims"""
    return json.dumps({"claims": [
        {"id": "CLM-001", "type": "medical", "amount": 250, "status": "approved"},
        {"id": "CLM-002", "type": "dental", "amount": 80, "status": "pending"},
    ]})


@tool
async def submit_claim(employee_id: str, claim_type: str, amount: float, service_date: str, provider: str) -> str:
    """Submit a new insurance claim"""
    return json.dumps({"status": "submitted", "amount": amount, "estimated_processing": "7-10 business days"})


@tool
async def get_fsa_balance(employee_id: str, account_type: str | None = None) -> str:
    """Get FSA (Flexible Spending Account) balance and transactions"""
    return json.dumps({"balance": 1250, "contributed": 2500, "spent": 1250, "deadline": "2025-03-15"})


@tool
async def get_hsa_contributions(employee_id: str, year: int | None = None) -> str:
    """View HSA contributions and investment options"""
    return json.dumps({"ytd_contributions": 3600, "employer_contributions": 500, "balance": 8500})


@tool
async def update_hsa_contribution(employee_id: str, new_contribution: float, effective_date: str | None = None) -> str:
    """Update HSA contribution amount"""
    return json.dumps({"success": True, "new_contribution": new_contribution})


@tool
async def get_wellness_points(employee_id: str) -> str:
    """Check wellness program points and rewards"""
    return json.dumps({"current_points": 750, "points_to_reward": 250, "available_rewards": ["$100 gift card", "Extra PTO day"]})


@tool
async def log_wellness_activity(employee_id: str, activity: str, date: str, proof: str | None = None) -> str:
    """Log wellness activity for points"""
    return json.dumps({"success": True, "activity": activity, "points_earned": 50, "new_total": 800})


@tool
async def get_life_event_options(event_type: str) -> str:
    """Get benefit change options for life events"""
    return json.dumps({"event_type": event_type, "eligible_changes": ["Add/remove dependents", "Change coverage level"],
                        "deadline": "30 days from event"})


ALL_BENEFITS_TOOLS = [
    enroll_benefits, update_dependents, compare_benefit_plans, get_benefits_summary,
    process_401k_change, open_enrollment_status, get_claim_status, submit_claim,
    get_fsa_balance, get_hsa_contributions, update_hsa_contribution, get_wellness_points,
    log_wellness_activity, get_life_event_options,
]
