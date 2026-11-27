import {
  GROUP_FIELDS,
  GROUP_LIMITS,
  type GroupBy,
  type GroupField,
  propertyOf,
} from "@/lib/contracts/query";
import { type PropertyChoices, propertyOptions } from "@/lib/views/dashboards/properties";

/**
 * The words and the choices of a group-by of the Flow, Step flow, Funnel and Map kinds (RTL-398):
 * one small chart per value. The Group by dropdown lists task, user and session, then the trace
 * properties as the Metric form lists them. Pure and safe for the browser.
 */

/** The title of the small chart of the traces without a value. */
export const NO_VALUE = "No value";
/** The dropdown's choice of no group-by. */
export const NO_GROUP = "none";

const FIELD_LABELS: Readonly<Record<GroupField, string>> = {
  task: "Task",
  user: "User",
  session: "Session",
};

/** What a group-by reads: "Task", or the property's own name. */
export function groupByLabel(by: GroupBy): string {
  return propertyOf(by) ?? FIELD_LABELS[by as GroupField];
}

/** The title of one value's small chart: the task's name for a task, "No value" for none. */
export function groupValueLabel(
  by: GroupBy,
  value: string | null,
  taskNames: Readonly<Record<string, string>> = {},
): string {
  if (value === null) return NO_VALUE;
  return by === "task" ? (taskNames[value] ?? value) : value;
}

/** "2 more values are not shown", or nothing when every value is drawn. */
export function leftOutNote(leftOut: number): string | null {
  if (leftOut <= 0) return null;
  return `${leftOut} more value${leftOut === 1 ? " is" : "s are"} not shown.`;
}

/** The options of the Group by dropdown: none, the fields of every trace, then the properties. */
export function groupByOptions(choices: PropertyChoices) {
  return [
    { value: NO_GROUP, label: "No grouping" },
    ...GROUP_FIELDS.map((value) => ({ value, label: FIELD_LABELS[value] })),
    ...propertyOptions(choices),
  ];
}

/** The count of values, within its limits. */
export function groupLimitOf(text: string): number | null {
  const number = Number.parseInt(text, 10);
  if (!Number.isFinite(number)) return null;
  return Math.min(GROUP_LIMITS.max, Math.max(GROUP_LIMITS.min, number));
}
