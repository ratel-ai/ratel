/**
 * The icons a workflow can wear: a fixed, generic set the naming model picks
 * from (one per workflow), so any domain finds a fit and the page never shows
 * an icon it cannot draw. Keys are kebab-case lucide names; the page maps each
 * to its component. Anything else falls back to {@link DEFAULT_WORKFLOW_ICON}.
 */

export const DEFAULT_WORKFLOW_ICON = "workflow";

/** Key to what it suits, as the naming model reads it. */
export const WORKFLOW_ICONS = {
  workflow: "anything that fits nothing else",
  calendar: "scheduling, dates, sprints, plans",
  "calendar-check": "planning that ends in a commitment",
  users: "teams, members, people",
  "user-plus": "inviting or onboarding someone",
  "user-check": "assigning work to someone",
  "git-pull-request": "code changes, pull requests",
  rocket: "releases, launches, deploys",
  "file-text": "documents, notes, reports to read",
  search: "finding or looking things up",
  "list-checks": "task lists, checklists, statuses",
  "list-todo": "creating or updating tasks",
  "clipboard-list": "reviews, audits, summaries of work",
  "chart-column": "reports, metrics, velocity",
  "message-square": "comments, chat, replies",
  mail: "email",
  send: "sending or posting something out",
  bell: "notifications, alerts",
  link: "linking items together",
  tag: "labels, tags, categories",
  folder: "projects, folders, workspaces",
  database: "data records, lookups in a store",
  "refresh-cw": "syncing, updating in a loop",
  settings: "configuration, settings",
  shield: "access, permissions, security",
  "credit-card": "payments, billing",
  "shopping-cart": "orders, carts, purchases",
  package: "shipping, inventory, packages",
  plane: "travel, trips, bookings",
  map: "places, routes, locations",
  bug: "bugs, incidents, errors",
  "book-open": "knowledge, help articles, docs",
  pencil: "editing or writing content",
  archive: "archiving, cleanup",
  "trash-2": "deleting things",
  flag: "milestones, goals, flags",
  download: "exports, downloads",
  upload: "imports, uploads",
  lightbulb: "ideas, suggestions",
} as const;

export type WorkflowIconKey = keyof typeof WORKFLOW_ICONS;

export const WORKFLOW_ICON_KEYS = Object.keys(WORKFLOW_ICONS) as WorkflowIconKey[];

const KEYS: ReadonlySet<string> = new Set(WORKFLOW_ICON_KEYS);

/** A stored or model-given icon key, or the default when it is not in the set. */
export function workflowIcon(value: unknown): WorkflowIconKey {
  return typeof value === "string" && KEYS.has(value)
    ? (value as WorkflowIconKey)
    : DEFAULT_WORKFLOW_ICON;
}
