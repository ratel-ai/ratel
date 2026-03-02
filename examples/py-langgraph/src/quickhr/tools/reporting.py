from __future__ import annotations

import json

from langchain_core.tools import tool


@tool
async def get_headcount_report(group_by: str | None = None, as_of_date: str | None = None) -> str:
    """Generate headcount report by department, location, or time period"""
    return json.dumps({"data": [
        {"group": "Engineering", "headcount": 45}, {"group": "Product", "headcount": 12},
        {"group": "Sales", "headcount": 30}, {"group": "HR", "headcount": 8},
    ], "total": 95})


@tool
async def get_turnover_report(start_date: str, end_date: str, department: str | None = None) -> str:
    """Generate employee turnover and retention report"""
    return json.dumps({"turnover_rate": 12.5, "voluntary_terminations": 8, "involuntary_terminations": 2, "new_hires": 15})


@tool
async def get_diversity_report(year: int | None = None, department: str | None = None) -> str:
    """Generate diversity and inclusion metrics report"""
    return json.dumps({"gender_distribution": {"male": 55, "female": 43, "non_binary": 2},
                        "leadership_diversity": {"female": 35, "underrepresented": 25}})


@tool
async def get_compensation_report(department: str | None = None, role: str | None = None, include_bonus: bool | None = None) -> str:
    """Generate compensation analysis report"""
    return json.dumps({"average_salary": 95000, "median_salary": 85000, "salary_range": {"min": 50000, "max": 250000}})


@tool
async def get_performance_report(review_cycle: str, department: str | None = None) -> str:
    """Generate performance review summary report"""
    return json.dumps({"review_cycle": review_cycle, "average_rating": 3.4, "completion_rate": 95})


@tool
async def get_absenteeism_report(start_date: str, end_date: str, department: str | None = None) -> str:
    """Generate absenteeism and attendance report"""
    return json.dumps({"avg_absence_rate": 3.2, "total_absence_days": 156})


@tool
async def get_benefits_utilization_report(year: int, benefit_type: str | None = None) -> str:
    """Generate benefits utilization report"""
    return json.dumps({"year": year, "health_utilization": 78, "dental_utilization": 65, "retirement_401k": 82})


@tool
async def get_recruiting_report(start_date: str, end_date: str, department: str | None = None) -> str:
    """Generate recruiting funnel and pipeline report"""
    return json.dumps({"total_applications": 450, "offers_made": 25, "offers_accepted": 20, "time_to_hire": "28 days"})


@tool
async def get_training_report(year: int, training_type: str | None = None) -> str:
    """Generate training completion and compliance report"""
    return json.dumps({"year": year, "completion_rate": 88, "total_hours_completed": 2500, "overdue": 15})


@tool
async def export_report(report_id: str, format: str, recipients: list[str] | None = None) -> str:
    """Export any generated report to file"""
    return json.dumps({"report_id": report_id, "format": format, "download_url": f"https://hr.company.com/reports/download/{report_id}.{format}"})


ALL_REPORTING_TOOLS = [
    get_headcount_report, get_turnover_report, get_diversity_report, get_compensation_report,
    get_performance_report, get_absenteeism_report, get_benefits_utilization_report,
    get_recruiting_report, get_training_report, export_report,
]
