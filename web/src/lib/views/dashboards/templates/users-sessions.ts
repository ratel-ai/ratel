import type { DashboardTemplate } from "@/lib/views/dashboards/templates/types";
import {
  formTemplateWidget,
  rqlTemplateWidget,
  SMALL,
} from "@/lib/views/dashboards/templates/widgets";

export const USERS_SESSIONS_TEMPLATE: DashboardTemplate = {
  id: "users-sessions",
  name: "Users and sessions",
  description:
    "Active end users and sessions per day, what each user costs, and the busiest users.",
  prompt: "Show my active users and sessions per day and which users spend the most",
  needs: ["users", "sessions"],
  property: false,
  widgets: [
    rqlTemplateWidget(
      "Active users per day",
      "line",
      "select time_bucket('1 day', started_at) as day, count(distinct user_id) as users\nfrom traces\nwhere user_id is not null\ngroup by day\norder by day desc",
    ),
    rqlTemplateWidget(
      "Sessions per day",
      "line",
      "select time_bucket('1 day', started_at) as day, count(distinct session_id) as sessions\nfrom traces\nwhere session_id is not null\ngroup by day\norder by day desc",
    ),
    rqlTemplateWidget(
      "Cost per user",
      "number",
      "select avg(cost_usd) as cost_per_user\nfrom users",
      SMALL,
    ),
    rqlTemplateWidget(
      "Top users",
      "table",
      "select user_id, trace_count, session_count, error_count, cost_usd\nfrom users\norder by cost_usd desc\nlimit 20",
    ),
    formTemplateWidget("table", "trace_count", "count", {
      title: "Traces per session",
      dimensions: ["session"],
    }),
  ],
};
