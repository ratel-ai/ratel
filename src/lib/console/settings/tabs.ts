import type { TabLink } from "@ratel/design-system/tabs";
import { organizationRoot, projectRoot } from "@/lib/console/navigation";

/**
 * The URL tabs of the two Settings pages (DESIGN.md, Everything is a URL).
 * Pure, so the tests can check which tabs a reader gets without a router.
 */

export function projectSettingsRoot(projectId: string): string {
  return `${projectRoot(projectId)}/settings`;
}

export function organizationSettingsRoot(slug: string): string {
  return `${organizationRoot(slug)}/settings`;
}

/** General, API keys, Developer (SDK events) and Danger zone. */
export function projectSettingsTabs(projectId: string): TabLink[] {
  const root = projectSettingsRoot(projectId);
  return [
    // `exact`: every other tab lives under this path.
    { href: root, label: "General", exact: true },
    { href: `${root}/api-keys`, label: "API keys" },
    { href: `${root}/developer`, label: "Developer" },
    { href: `${root}/danger`, label: "Danger zone" },
  ];
}

/** General for everyone; Danger zone only for the admins who can use it. */
export function organizationSettingsTabs(slug: string, options: { danger: boolean }): TabLink[] {
  const root = organizationSettingsRoot(slug);
  const tabs: TabLink[] = [{ href: root, label: "General", exact: true }];
  if (options.danger) tabs.push({ href: `${root}/danger`, label: "Danger zone" });
  return tabs;
}

export type SearchParamsRecord = Record<string, string | readonly string[] | undefined>;

/**
 * `path` with the given query string, values in order, repeated keys kept. A
 * moved page redirects through this so a shared link keeps its filters.
 */
export function withQuery(path: string, params: SearchParamsRecord): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of typeof value === "string" ? [value] : value) query.append(key, item);
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}
