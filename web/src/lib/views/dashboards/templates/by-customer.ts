import type { DashboardTemplate } from "@/lib/views/dashboards/templates/types";
import { formTemplateWidget, rqlTemplateWidget } from "@/lib/views/dashboards/templates/widgets";

/**
 * Cost, traces, errors and users grouped by one indexed trace property that the caller names (for
 * example `customer` or `plan`). The caller checks that the property is indexed (`index.ts`).
 */
export const BY_CUSTOMER_TEMPLATE: DashboardTemplate = {
  id: "by-customer",
  name: "By customer",
  description: "Cost, traces, error rate and users for each value of one indexed trace property.",
  prompt: "Break down cost, traces and errors by customer",
  needs: ["property"],
  property: true,
  widgets: (property) => [
    formTemplateWidget("table", "cost", "sum", {
      title: `Cost by ${property}`,
      dimensions: [{ property }],
    }),
    formTemplateWidget("table", "trace_count", "count", {
      title: `Traces by ${property}`,
      dimensions: [{ property }],
    }),
    formTemplateWidget("table", "error_rate", "rate", {
      title: `Error rate by ${property}`,
      dimensions: [{ property }],
    }),
    rqlTemplateWidget(
      `Users by ${property}`,
      "table",
      `select properties[${literal(property)}] as value, count(distinct user_id) as users\nfrom traces\nwhere properties[${literal(property)}] is not null\n  and user_id is not null\ngroup by value\norder by users desc\nlimit 50`,
    ),
    formTemplateWidget("line", "cost", "sum", {
      title: `Cost per day by ${property}`,
      dimensions: [{ property }],
      bucket: "day",
    }),
  ],
};

function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}
