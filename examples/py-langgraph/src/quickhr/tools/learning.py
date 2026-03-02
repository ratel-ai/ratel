from __future__ import annotations

import json

from langchain_core.tools import tool


@tool
async def get_courses(category: str | None = None, required: bool | None = None, format: str | None = None) -> str:
    """List available training courses and programs"""
    return json.dumps({"courses": [
        {"id": "CRS-001", "name": "Leadership Fundamentals", "format": "online", "duration": "4 hours", "required": False},
        {"id": "CRS-002", "name": "Security Awareness", "format": "online", "duration": "1 hour", "required": True},
        {"id": "CRS-003", "name": "Project Management Basics", "format": "hybrid", "duration": "8 hours", "required": False},
    ]})


@tool
async def enroll_course(employee_id: str, course_id: str, session_id: str | None = None) -> str:
    """Enroll employee in a training course"""
    return json.dumps({"course_id": course_id, "status": "enrolled"})


@tool
async def get_training_progress(employee_id: str, course_id: str | None = None) -> str:
    """View employee training progress and completion status"""
    return json.dumps({"in_progress": [{"course_id": "CRS-001", "progress": 60, "deadline": "2025-03-15"}],
                        "completed": [{"course_id": "CRS-002", "completed_date": "2025-01-10", "score": 95}]})


@tool
async def complete_training(employee_id: str, course_id: str, module_id: str, score: float | None = None) -> str:
    """Mark a training module as complete"""
    return json.dumps({"success": True, "module_id": module_id, "score": score})


@tool
async def get_skill_gaps(employee_id: str | None = None, team_id: str | None = None, target_role: str | None = None) -> str:
    """Analyze skill gaps for an employee or team"""
    return json.dumps({"gaps": [
        {"skill": "Cloud Architecture", "current": 2, "required": 4, "priority": "high"},
        {"skill": "Team Leadership", "current": 3, "required": 4, "priority": "medium"},
    ]})


@tool
async def recommend_courses(employee_id: str, career_path: str | None = None) -> str:
    """Get personalized course recommendations for employee"""
    return json.dumps({"recommendations": [
        {"course_id": "CRS-004", "name": "Advanced TypeScript", "relevance": 95},
        {"course_id": "CRS-005", "name": "Technical Leadership", "relevance": 88},
    ]})


@tool
async def create_learning_path(name: str, course_ids: list[str], target_role: str | None = None) -> str:
    """Create custom learning path for employee development"""
    return json.dumps({"name": name, "courses": course_ids, "estimated_duration": "40 hours"})


@tool
async def assign_learning_path(employee_id: str, path_id: str, deadline: str | None = None) -> str:
    """Assign learning path to employee"""
    return json.dumps({"success": True, "employee_id": employee_id, "path_id": path_id})


@tool
async def get_training_budget(employee_id: str | None = None, department_id: str | None = None, year: int | None = None) -> str:
    """Check training budget allocation and spending"""
    return json.dumps({"allocated": 5000, "spent": 1500, "remaining": 3500, "pending_requests": 800})


@tool
async def request_external_training(employee_id: str, training_name: str, cost: float, justification: str, provider: str | None = None) -> str:
    """Request approval for external training or conference"""
    return json.dumps({"status": "pending_approval", "training_name": training_name, "cost": cost, "approver": "Direct Manager"})


ALL_LEARNING_TOOLS = [
    get_courses, enroll_course, get_training_progress, complete_training,
    get_skill_gaps, recommend_courses, create_learning_path, assign_learning_path,
    get_training_budget, request_external_training,
]
