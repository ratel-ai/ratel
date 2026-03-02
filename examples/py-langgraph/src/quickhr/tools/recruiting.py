from __future__ import annotations

import json

from langchain_core.tools import tool


@tool
async def post_job(title: str, department: str, description: str, requirements: list[str], remote: bool, salary: dict | None = None) -> str:
    """Create and publish a job posting"""
    return json.dumps({"status": "published", "posted_to": ["careers page", "LinkedIn", "Indeed"]})


@tool
async def list_candidates(job_id: str, stage: str | None = None) -> str:
    """List candidates for a job posting"""
    candidates = [
        {"id": "CAND-001", "name": "Alice Johnson", "stage": "interview", "rating": 4.2},
        {"id": "CAND-002", "name": "Bob Smith", "stage": "screening", "rating": 3.8},
        {"id": "CAND-003", "name": "Carol Williams", "stage": "interview", "rating": 4.5},
    ]
    if stage:
        candidates = [c for c in candidates if c["stage"] == stage]
    return json.dumps({"candidates": candidates, "total": len(candidates)})


@tool
async def review_application(candidate_id: str) -> str:
    """Review a candidate's application and materials"""
    return json.dumps({"candidate": {"id": candidate_id, "name": "Alice Johnson"},
                        "resume": {"parsed_skills": ["JavaScript", "React", "TypeScript", "Node.js"]}})


@tool
async def schedule_interview(candidate_id: str, interviewer_ids: list[str], interview_type: str, duration: int, preferred_times: list[str] | None = None) -> str:
    """Schedule an interview with a candidate"""
    return json.dumps({"scheduled_at": "2025-02-15T10:00:00", "calendar": "sent"})


@tool
async def submit_interview_feedback(interview_id: str, rating: int, recommendation: str, notes: str, skills: list[dict]) -> str:
    """Submit feedback after interviewing a candidate"""
    return json.dumps({"submitted": True, "candidate_score": 4.2})


@tool
async def move_candidate(candidate_id: str, new_stage: str, reason: str | None = None) -> str:
    """Move candidate to a different stage in the pipeline"""
    return json.dumps({"success": True, "previous_stage": "interview", "new_stage": new_stage})


@tool
async def send_rejection(candidate_id: str, template: str, personal_note: str | None = None) -> str:
    """Send a rejection email to a candidate"""
    return json.dumps({"sent": True, "message": "Rejection email sent"})


@tool
async def get_recruiting_metrics(job_id: str | None = None, start_date: str | None = None, end_date: str | None = None) -> str:
    """Get recruiting pipeline metrics and analytics"""
    return json.dumps({"applications": 145, "interviews": 32, "offers": 5, "hires": 3, "avg_time_to_hire": "23 days"})


@tool
async def get_job_postings(status: str | None = None, department: str | None = None) -> str:
    """List all active job postings"""
    return json.dumps({"postings": [
        {"id": "JOB-001", "title": "Senior Engineer", "status": "active", "applicants": 45},
        {"id": "JOB-002", "title": "Product Manager", "status": "active", "applicants": 32},
    ]})


@tool
async def close_job_posting(job_id: str, reason: str) -> str:
    """Close a job posting"""
    return json.dumps({"success": True, "job_id": job_id, "status": "closed"})


@tool
async def reopen_job_posting(job_id: str) -> str:
    """Reopen a closed job posting"""
    return json.dumps({"success": True, "job_id": job_id, "status": "active"})


@tool
async def get_candidate_scorecard(candidate_id: str) -> str:
    """Get comprehensive scorecard for a candidate"""
    return json.dumps({"candidate_id": candidate_id, "overall_score": 4.2, "recommendation": "Strong hire"})


@tool
async def reschedule_interview(interview_id: str, new_date_time: str, reason: str | None = None) -> str:
    """Reschedule an existing interview"""
    return json.dumps({"success": True, "interview_id": interview_id, "new_date_time": new_date_time})


@tool
async def cancel_interview(interview_id: str, reason: str, notify_candidate: bool | None = None) -> str:
    """Cancel a scheduled interview"""
    return json.dumps({"success": True, "interview_id": interview_id})


@tool
async def get_referrals(job_id: str | None = None, referrer_id: str | None = None) -> str:
    """Get employee referrals for job postings"""
    return json.dumps({"referrals": [
        {"id": "REF-001", "candidate_name": "John Smith", "status": "hired", "bonus": 2500},
    ]})


@tool
async def submit_referral(referrer_id: str, candidate_name: str, candidate_email: str, job_id: str, relationship: str | None = None) -> str:
    """Submit an employee referral for a position"""
    return json.dumps({"status": "submitted", "candidate_email": candidate_email})


@tool
async def get_interview_availability(interviewer_ids: list[str], date_range: dict, duration: int) -> str:
    """Get interviewer availability for scheduling"""
    return json.dumps({"available_slots": [
        {"datetime": "2025-02-10T10:00:00", "available": True},
        {"datetime": "2025-02-10T14:00:00", "available": True},
    ]})


@tool
async def create_talent_pool(name: str, criteria: dict | None = None) -> str:
    """Create a talent pool for future openings"""
    return json.dumps({"name": name, "created": True})


@tool
async def add_to_talent_pool(pool_id: str, candidate_id: str) -> str:
    """Add candidate to talent pool"""
    return json.dumps({"success": True, "pool_id": pool_id, "candidate_id": candidate_id})


ALL_RECRUITING_TOOLS = [
    post_job, list_candidates, review_application, schedule_interview,
    submit_interview_feedback, move_candidate, send_rejection, get_recruiting_metrics,
    get_job_postings, close_job_posting, reopen_job_posting, get_candidate_scorecard,
    reschedule_interview, cancel_interview, get_referrals, submit_referral,
    get_interview_availability, create_talent_pool, add_to_talent_pool,
]
