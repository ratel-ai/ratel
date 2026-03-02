from __future__ import annotations

import json

from langchain_core.tools import tool


@tool
async def start_onboarding(employee_id: str, start_date: str, buddy_id: str | None = None) -> str:
    """Initiate the onboarding workflow for a new employee"""
    return json.dumps({"status": "started", "message": "Onboarding workflow initiated",
                        "tasks": [{"id": "TASK-001", "name": "Complete I-9", "status": "pending"},
                                  {"id": "TASK-002", "name": "Setup workstation", "status": "pending"},
                                  {"id": "TASK-003", "name": "Complete orientation", "status": "pending"},
                                  {"id": "TASK-004", "name": "Meet team", "status": "pending"}]})


@tool
async def send_offer_letter(candidate_id: str, role: str, salary: float, start_date: str, benefits: list[str]) -> str:
    """Generate and send offer letter to a candidate"""
    return json.dumps({"status": "sent", "sent_to": f"candidate-{candidate_id}@email.com"})


@tool
async def create_accounts(employee_id: str, systems: list[str]) -> str:
    """Create IT accounts for new employee (email, Slack, tools)"""
    return json.dumps({"created": [{"system": s, "username": f"{employee_id}@company.com"} for s in systems], "failed": []})


@tool
async def schedule_orientation(employee_id: str, sessions: list[str], preferred_dates: list[str] | None = None) -> str:
    """Schedule orientation sessions for new employee"""
    return json.dumps({"scheduled": [{"session": s, "time": "10:00 AM", "location": "Conference Room A"} for s in sessions]})


@tool
async def assign_equipment(employee_id: str, items: list[str], shipping_address: str) -> str:
    """Assign and ship equipment to new employee (laptop, monitor, etc.)"""
    return json.dumps({"items": [{"name": i, "status": "ordered"} for i in items], "estimated_delivery": "5 business days"})


@tool
async def assign_mentor(employee_id: str, mentor_id: str) -> str:
    """Assign an onboarding buddy/mentor to new employee"""
    return json.dumps({"success": True, "message": "Mentor assigned, both parties notified"})


@tool
async def get_onboarding_status(employee_id: str) -> str:
    """Check progress of an employee's onboarding"""
    return json.dumps({"progress": "60%", "completed_tasks": 2, "pending_tasks": 2, "blockers": []})


@tool
async def complete_onboarding_task(onboarding_id: str, task_id: str, notes: str | None = None) -> str:
    """Mark an onboarding task as complete"""
    return json.dumps({"success": True, "overall_progress": "80%", "remaining_tasks": 1})


@tool
async def get_onboarding_checklist(role: str | None = None, department: str | None = None) -> str:
    """Get the standard onboarding checklist for a role"""
    return json.dumps({"checklist": [
        {"task": "Complete I-9", "category": "compliance", "required": True},
        {"task": "IT account setup", "category": "it", "required": True},
        {"task": "Benefits enrollment", "category": "hr", "required": True},
        {"task": "Meet team", "category": "social", "required": False},
    ]})


@tool
async def get_onboarding_metrics(start_date: str | None = None, end_date: str | None = None, department: str | None = None) -> str:
    """Get onboarding completion metrics and statistics"""
    return json.dumps({"avg_completion_time": "14 days", "completion_rate": 92, "active_onboardings": 5})


@tool
async def get_ramp_goals(employee_id: str) -> str:
    """Get 30/60/90 day ramp-up goals for new hire"""
    return json.dumps({"day30": ["Complete all training", "Ship first bug fix"],
                        "day60": ["Own small feature", "Present at team meeting"],
                        "day90": ["Lead small project", "Mentor new hire"]})


@tool
async def set_ramp_goals(employee_id: str, goals: dict) -> str:
    """Set 30/60/90 day ramp-up goals for new hire"""
    return json.dumps({"success": True, "goals_set": len(goals)})


@tool
async def schedule_welcome_meeting(employee_id: str, attendees: list[str], preferred_date: str | None = None) -> str:
    """Schedule welcome meeting with team for new hire"""
    return json.dumps({"scheduled": True, "date": "2025-03-01"})


@tool
async def request_badge(employee_id: str, access_level: str, locations: list[str] | None = None) -> str:
    """Request building access badge for new employee"""
    return json.dumps({"status": "processing", "estimated_delivery": "3-5 business days"})


ALL_ONBOARDING_TOOLS = [
    start_onboarding, send_offer_letter, create_accounts, schedule_orientation,
    assign_equipment, assign_mentor, get_onboarding_status, complete_onboarding_task,
    get_onboarding_checklist, get_onboarding_metrics, get_ramp_goals, set_ramp_goals,
    schedule_welcome_meeting, request_badge,
]
