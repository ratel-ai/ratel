from quickhr.tools.employees import ALL_EMPLOYEE_TOOLS
from quickhr.tools.time_off import ALL_TIME_OFF_TOOLS
from quickhr.tools.payroll import ALL_PAYROLL_TOOLS
from quickhr.tools.onboarding import ALL_ONBOARDING_TOOLS
from quickhr.tools.recruiting import ALL_RECRUITING_TOOLS
from quickhr.tools.compliance import ALL_COMPLIANCE_TOOLS
from quickhr.tools.benefits import ALL_BENEFITS_TOOLS
from quickhr.tools.admin import ALL_ADMIN_TOOLS
from quickhr.tools.reporting import ALL_REPORTING_TOOLS
from quickhr.tools.learning import ALL_LEARNING_TOOLS

ALL_TOOLS = (
    ALL_EMPLOYEE_TOOLS
    + ALL_TIME_OFF_TOOLS
    + ALL_PAYROLL_TOOLS
    + ALL_ONBOARDING_TOOLS
    + ALL_RECRUITING_TOOLS
    + ALL_COMPLIANCE_TOOLS
    + ALL_BENEFITS_TOOLS
    + ALL_ADMIN_TOOLS
    + ALL_REPORTING_TOOLS
    + ALL_LEARNING_TOOLS
)

TOOLS_BY_NAME = {t.name: t for t in ALL_TOOLS}
