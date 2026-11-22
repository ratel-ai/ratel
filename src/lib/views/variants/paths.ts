import type { RangePreset } from "@/lib/synthesis/dashboard";

/** The window every Variants link keeps (RC-871). */
export interface VariantsQuery {
  range: RangePreset | "custom";
  from?: string;
  to?: string;
}

export function variantsHref(projectId: string, query?: VariantsQuery): string {
  return `/project/${projectId}/variants${search(query)}`;
}

export function variantExperimentHref(
  projectId: string,
  experiment: string,
  query?: VariantsQuery,
): string {
  return `/project/${projectId}/variants/${encodeURIComponent(experiment)}${search(query)}`;
}

function search(query: VariantsQuery | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams({ range: query.range });
  if (query.range === "custom" && query.from && query.to) {
    params.set("from", query.from);
    params.set("to", query.to);
  }
  return `?${params.toString()}`;
}
