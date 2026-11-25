import { z } from "zod";
import { hasNoNul, NUL_PROBLEM, shownValue } from "@/lib/contracts/json-text";
import { type PortableQuery, portableQuerySchema, type Query } from "@/lib/contracts/query";
import type { MetricFeatures } from "@/lib/synthesis/metrics/catalog";
import { defaultsSchema, filtersProblem } from "@/lib/views/dashboards/filters";
import { compacted, gridPositionSchema } from "@/lib/views/dashboards/layout";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import { isWidget } from "@/lib/views/dashboards/stored-widget";
import {
  type Dashboard,
  MAX_DASHBOARD_NAME,
  MAX_WIDGET_TITLE,
  MAX_WIDGETS,
  type ScorerOption,
  WIDGET_CHARTS,
  type Widget,
} from "@/lib/views/dashboards/types";
import { queryName, scorersOfMetric } from "@/lib/views/dashboards/widget";

/**
 * A dashboard as one JSON document: what moves between projects, and what an agent can write. It
 * has no database id. A scorer is named by its name, and the project that imports it finds it.
 * `docs/schemas/dashboard.schema.json` is generated from here.
 */

export const DOCUMENT_TYPE = "ratel.dashboard";
export const DOCUMENT_VERSION = 1;

/** Stands for a scorer that was deleted under its widget: it has no name any more. */
const DELETED_SCORER = "Deleted scorer";
/** Where a scorer's name is checked as if it were a scorer. Never stored. */
const ANY_SCORER = "00000000-0000-4000-8000-000000000000";

const widgetSchema = z.strictObject({
  title: z.string().trim().max(MAX_WIDGET_TITLE).refine(hasNoNul, NUL_PROBLEM).default(""),
  query: portableQuerySchema,
  chart: z.enum(WIDGET_CHARTS),
  layout: gridPositionSchema,
});

const frame = {
  type: z.literal(DOCUMENT_TYPE, {
    error: ({ input }) =>
      `This is not a Ratel dashboard: its type is "${shownValue(input)}", not "${DOCUMENT_TYPE}".`,
  }),
  version: z.literal(DOCUMENT_VERSION, {
    error: ({ input }) =>
      `Unknown dashboard version "${shownValue(input)}". The version is ${DOCUMENT_VERSION}.`,
  }),
  name: z
    .string("Give the dashboard a name.")
    .trim()
    .min(1, "Give the dashboard a name.")
    .max(MAX_DASHBOARD_NAME, `A dashboard name can have ${MAX_DASHBOARD_NAME} characters.`)
    .refine(hasNoNul, NUL_PROBLEM),
  filters: defaultsSchema.shape.filters.default({}),
  range: defaultsSchema.shape.range.default(null),
};
const tooMany = `A dashboard can have ${MAX_WIDGETS} widgets.`;

export const dashboardDocumentSchema = z.strictObject({
  ...frame,
  widgets: z.array(widgetSchema).max(MAX_WIDGETS),
});
export type DashboardDocument = Omit<z.infer<typeof dashboardDocumentSchema>, "filters"> &
  Pick<Dashboard, "filters">;

/** The widgets one by one, so a refusal names its widget. */
const importSchema = z.strictObject({
  ...frame,
  widgets: z.array(z.unknown()).max(MAX_WIDGETS, tooMany),
});

/** A document's content, with the names of the scorers its project does not have. */
export type ImportedDashboard = Pick<Dashboard, "name" | "filters" | "range"> & {
  widgets: Omit<Widget, "id">[];
  missingScorers: string[];
};

export function exportDashboard(
  { name, filters, range, widgets }: Pick<Dashboard, "name" | "filters" | "range" | "widgets">,
  scorers: readonly Pick<ScorerOption, "id" | "name">[],
): DashboardDocument {
  return {
    type: DOCUMENT_TYPE,
    version: DOCUMENT_VERSION,
    name,
    filters,
    range,
    // A broken one is no part of a document that can be imported.
    widgets: widgets.filter(isWidget).map(({ title, query, chart, layout, missingScorer }) => {
      return { title, query: portable(query, scorers, missingScorer), chart, layout };
    }),
  };
}

function portable(
  query: Query,
  scorers: readonly Pick<ScorerOption, "id" | "name">[],
  missingScorer: string | undefined,
): PortableQuery {
  const named = (id: string) => ({
    name: scorers.find((scorer) => scorer.id === id)?.name ?? missingScorer ?? DELETED_SCORER,
  });
  switch (query.kind) {
    case "metric":
    case "geography": {
      const { scorer, ...rest } = query.filters;
      const name = scorer ? named(scorer.id) : missingScorer ? { name: missingScorer } : null;
      return { ...query, filters: { ...rest, ...(name ? { scorer: name } : {}) } };
    }
    case "funnel":
      return {
        ...query,
        steps: query.steps.map(({ name, condition }) => ({
          name,
          condition:
            condition.type === "scorer"
              ? { ...condition, scorer: named(condition.scorer.id) }
              : condition,
        })),
      };
    default:
      return query;
  }
}

/** A document from outside, under the rules of the widget editor. A missing scorer is no refusal. */
export function importDashboard(
  raw: unknown,
  { scorers, features }: { scorers: readonly ScorerOption[]; features: MetricFeatures },
): { ok: true; dashboard: ImportedDashboard } | { ok: false; error: string } {
  const parsed = importSchema.safeParse(raw, {
    error: ({ code, path, keys }) => {
      if (code === "unrecognized_keys") {
        const at = (keys as string[]).map((key) => [...(path ?? []), key].join("."));
        return `The dashboard has unknown fields: ${at.join(", ")}.`;
      }
      return path?.length
        ? `The dashboard is invalid at "${path.join(".")}".`
        : "The dashboard is not a JSON object.";
    },
  });
  if (!parsed.success) return { ok: false, error: refusalOf(parsed.error, raw) };
  const { name, filters, range } = parsed.data;
  const widgets: Widget[] = [];
  for (const [index, rawWidget] of parsed.data.widgets.entries()) {
    const read = importWidget(rawWidget, scorers, features);
    const error = read.ok ? filtersProblem([read.widget.query], filters) : read.error;
    if (!read.ok || error) return { ok: false, error: `${placeName(rawWidget, index)}: ${error}` };
    widgets.push({ ...read.widget, id: String(index) });
  }
  const missing = widgets.flatMap(({ missingScorer }) => missingScorer ?? []);
  return {
    ok: true,
    dashboard: {
      name,
      filters,
      range,
      widgets: compacted(widgets).map(({ id: _, ...widget }) => widget),
      missingScorers: [...new Set(missing)],
    },
  };
}

/** What it is comes first: a wrong type explains every other problem. */
function refusalOf({ issues }: z.ZodError, raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return issues[0].message;
  const order = ["type", "version"];
  const first = order.flatMap((key) => issues.find(({ path }) => path[0] === key) ?? [])[0];
  return (first ?? issues[0]).message;
}

function importWidget(
  raw: unknown,
  scorers: readonly ScorerOption[],
  features: MetricFeatures,
): { ok: true; widget: Omit<Widget, "id"> } | { ok: false; error: string } {
  const { layout: rawLayout, ...rest } = record(raw);
  const layout = gridPositionSchema.safeParse(rawLayout);
  if (!layout.success)
    return { ok: false, error: "The layout must be x, y, w and h on 12 columns." };
  const named = withScorersAs(rest, ANY_SCORER);
  if (named === null) return { ok: false, error: 'A scorer is given by its name: {"name": "…"}.' };
  const parsed = parseWidget(named.widget, features);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    widget: { ...resolved(parsed.widget, named.scorers, scorers), layout: layout.data },
  };
}

/** The widget with each scorer's name exchanged for an id, so the editor's parser reads it. */
function withScorersAs(
  widget: Record<string, unknown>,
  id: string,
): { widget: Record<string, unknown>; scorers: string[] } | null {
  const names: string[] = [];
  let valid = true;
  const exchanged = (holder: unknown): unknown => {
    const { scorer, ...rest } = record(holder);
    if (scorer === undefined) return holder;
    const { name, ...more } = record(scorer);
    const text = typeof name === "string" ? name.trim() : "";
    if (!text || text.length > 200 || !hasNoNul(text) || Object.keys(more).length > 0)
      valid = false;
    names.push(text);
    return { ...rest, scorer: { id } };
  };
  const query = record(widget.query);
  const next = { ...query };
  if (query.filters !== undefined) next.filters = exchanged(query.filters);
  if (query.kind === "funnel" && Array.isArray(query.steps))
    next.steps = query.steps.map((step) =>
      isRecord(step) ? { ...step, condition: exchanged(step.condition) } : step,
    );
  if (!valid) return null;
  return { widget: names.length > 0 ? { ...widget, query: next } : widget, scorers: names };
}

/** The names become the project's scorers, in their order. Of two of one name, the first the query can read. */
function resolved(
  widget: Omit<Widget, "id" | "layout">,
  names: readonly string[],
  scorers: readonly ScorerOption[],
): Omit<Widget, "id" | "layout"> {
  if (names.length === 0) return widget;
  const { query } = widget;
  const missing: string[] = [];
  let next = 0;
  const found = (readable: readonly ScorerOption[]): { id: string } | null => {
    const name = names[next++];
    const scorer = readable.find((candidate) => candidate.name.trim() === name);
    if (!scorer) missing.push(name);
    return scorer ? { id: scorer.id } : null;
  };
  const read = (): Query => {
    switch (query.kind) {
      case "metric":
      case "geography": {
        const { scorer: _, ...filters } = query.filters;
        const scorer = found(scorersOfMetric(query.measures[0].measure, scorers));
        return { ...query, filters: scorer ? { ...filters, scorer } : filters };
      }
      case "funnel":
        return {
          ...query,
          steps: query.steps.map((step) => {
            const { condition } = step;
            if (condition.type !== "scorer") return step;
            const verdict = condition.result !== undefined;
            const scorer = found(scorers.filter((option) => option.verdict === verdict));
            return scorer ? { ...step, condition: { ...condition, scorer } } : step;
          }),
        };
      default:
        return query;
    }
  };
  const whole = read();
  return { ...widget, query: whole, ...(missing[0] ? { missingScorer: missing[0] } : {}) };
}

/** `Widget 2 "Speed"`: how a person finds it in the document. */
function placeName(raw: unknown, index: number): string {
  const { title, query } = record(raw);
  const own = typeof title === "string" ? title.trim().slice(0, MAX_WIDGET_TITLE) : "";
  const parsed = portableQuerySchema.safeParse(query);
  const name = own || (parsed.success ? queryName(parsed.data) : "");
  return `Widget ${index + 1}${name ? ` "${name}"` : ""}`;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
