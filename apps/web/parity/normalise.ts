/**
 * Every difference the parity tests treat as equal (temporary parity harness, RTL-45).
 *
 * This file is the only place where Ratel Cloud's answer and this repository's answer are
 * allowed to differ and still compare equal. A parity test calls these functions on both
 * sides and then compares with `deepEqual`; it never filters, renames or skips by itself.
 * Each rule names the natural difference it stands for, in the words of the audit's
 * "Natural differences, confirmed" table (identity, flags, private features, layout) or of
 * ADR-0030 (the product name, this deployment's own address).
 *
 * A fix does not get to add a rule here to make its test pass: a new rule is a claim that a
 * difference is natural, and that is Berca's call.
 */

export interface Rule {
  id: string;
  /** The natural difference the rule stands for. */
  naturalDifference: string;
  /** What exactly is treated as equal. */
  treatsAsEqual: string;
}

export const RULES = {
  productName: {
    id: "product-name",
    naturalDifference: 'The product name: Cloud says "Ratel Cloud", this edition says APP_NAME.',
    treatsAsEqual: "Either name, and the APP_NAME placeholder in a source template, reads <app>.",
  },
  serviceName: {
    id: "service-name",
    naturalDifference:
      "The product name, as the OpenTelemetry service name of the platform itself.",
    treatsAsEqual: 'service.name "ratel-cloud" and "ratel-platform".',
  },
  routeGroup: {
    id: "route-group",
    naturalDifference:
      "Layout: Cloud's pages sit in the (app) route group, this edition's in (console).",
    treatsAsEqual: "A Cloud path under app/(app)/ and the same path under app/(console)/.",
  },
  movedFiles: {
    id: "moved-files",
    naturalDifference:
      "Layout: the split moved files into layers (map.json), and the job handler table and the proxy became registrations and routes.",
    treatsAsEqual: "A Cloud source file and the file or files that hold the same code here.",
  },
  baseUrl: {
    id: "base-url",
    naturalDifference:
      "This deployment's own address: a snippet here names where this installation listens, Cloud's SDK default is Cloud.",
    treatsAsEqual: "A snippet's attach call with and without the baseUrl option.",
  },
  privateFeatures: {
    id: "private-features",
    naturalDifference:
      "Private features: the hosted APIs (Embeddings, Tool Picker), Members and Billing exist only on Cloud.",
    treatsAsEqual: "Cloud's navigation with those destinations removed.",
  },
  singleOrganization: {
    id: "single-organization",
    naturalDifference:
      "Identity: one local organization and no login, so there is no organization switcher.",
    treatsAsEqual:
      '⌘K without Cloud\'s "All organizations" and without this edition\'s "All projects" and "New project" entries; the organization rail\'s Settings under either id.',
  },
} as const satisfies Record<string, Rule>;

export type Edition = "cloud" | "oss";

// ── product-name ──────────────────────────────────────────────────────────────────────────

const CLOUD_PRODUCT = "Ratel Cloud";
const APP = "<app>";

/** `RULES.productName`. `appName` is this build's configured name. */
export function productName(text: string, appName?: string): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder as it is written in a source file
  let out = text.split(CLOUD_PRODUCT).join(APP).split("${APP_NAME}").join(APP);
  if (appName) out = out.split(appName).join(APP);
  return out;
}

/** `RULES.serviceName`. */
export function serviceName(name: string): string {
  return name === "ratel-cloud" || name === "ratel-platform" ? "<platform>" : name;
}

// ── route-group, moved-files ──────────────────────────────────────────────────────────────

/** `RULES.routeGroup`. */
export function routeGroup(path: string): string {
  return path.replace(/^app\/\(app\)\//, "app/(console)/");
}

/**
 * `RULES.movedFiles`: where a Cloud source file's code lives here. A trailing `/**` means every
 * non-test source file under that folder. Paths are relative to the application root.
 */
const MOVED_FILES: Readonly<Record<string, readonly string[]>> = {
  "components/shell/Sidebar.tsx": ["components/console/shell/Sidebar.tsx"],
  "components/settings/v2/ApiKeysSettings.tsx": ["components/console/settings/ApiKeysSettings.tsx"],
  "components/settings/v2/DeveloperSettings.tsx": [
    "components/console/settings/DeveloperSettings.tsx",
  ],
  "components/home/v2/OverviewPage.tsx": ["components/console/home/OverviewPage.tsx"],
  "components/playground/PlaygroundWorkbench.tsx": [
    "components/console/playground/PlaygroundWorkbench.tsx",
  ],
  // The job handler table became one registration per module.
  "lib/jobs/handlers.ts": ["lib/**/register.ts"],
  // The enumerated drain became the registered drain steps.
  "lib/cron/drain.ts": ["lib/**/register.ts"],
  // The Fixes load's rewrites half became the quality module's seam filler.
  "lib/fixes/load.ts": ["lib/views/fixes/load.ts", "lib/views/quality/fix-rewrites.ts"],
  // No proxy here (ADR-0029): the routes and the console scope serve project pages.
  "lib/scope/proxy-handler.ts": ["app/**", "lib/console/**"],
};

/** The files of this repository that hold a Cloud file's code (`RULES.routeGroup`, `RULES.movedFiles`). */
export function ossFiles(cloudPath: string): readonly string[] {
  return MOVED_FILES[cloudPath] ?? [routeGroup(cloudPath)];
}

// ── base-url ──────────────────────────────────────────────────────────────────────────────

/** `RULES.baseUrl`: an attach call's `baseUrl: "<this deployment>"` option is not a difference. */
export function snippet(text: string): string {
  return text
    .replace(/baseUrl: "[^"]*",\s*/g, "")
    .replace(/,\s*baseUrl: "[^"]*"/g, "")
    .replace(/,\s*\{\s*baseUrl: "[^"]*"\s*\}/g, "");
}

// ── private-features, single-organization ─────────────────────────────────────────────────

/** Rail ids of Cloud-only destinations (`RULES.privateFeatures`). */
const PRIVATE_NAV_IDS: ReadonlySet<string> = new Set([
  "apis",
  "embeddings",
  "tool-picker",
  "members",
  "billing",
]);
/** Their addresses, as the last path segments (`RULES.privateFeatures`). */
const PRIVATE_NAV_TAILS = ["/models/embeddings", "/models/tool-picker", "/team", "/billing"];
/** `RULES.singleOrganization`. */
const SWITCHER_HREFS: ReadonlySet<string> = new Set(["/organizations"]);
const OSS_ONLY_COMMAND_IDS: ReadonlySet<string> = new Set(["org:projects", "org:new-project"]);

export interface RailRow {
  id: string;
  label: string;
  href: string;
  exact?: boolean;
  also?: readonly string[];
  shortcut?: string;
  keywords?: readonly string[];
  activeId?: string;
  /** The item it is folded under. */
  parent?: string;
  /** The heading of the section it opens. */
  sectionLabel?: string;
}

function isPrivateHref(href: string): boolean {
  return PRIVATE_NAV_TAILS.some((tail) => href.endsWith(tail));
}

/** The rail as both editions can show it (`RULES.privateFeatures`, `RULES.singleOrganization`). */
export function rail(edition: Edition, rows: readonly RailRow[]): RailRow[] {
  const kept = rows.filter(
    (row) => !PRIVATE_NAV_IDS.has(row.id) && !PRIVATE_NAV_IDS.has(row.parent ?? ""),
  );
  // A private group that carried its section's heading hands nothing on: the section is gone with it.
  return kept.map((row) =>
    edition === "oss" && row.id === "org-settings" ? { ...row, id: "settings" } : row,
  );
}

/** A rail id as both editions name it (`RULES.singleOrganization`). */
export function railId(edition: Edition, id: string | null): string | null {
  return edition === "oss" && id === "org-settings" ? "settings" : id;
}

export interface CommandRow {
  label: string;
  group: string;
  href: string;
  keywords?: readonly string[];
}

/** ⌘K's entries as both editions can list them (`RULES.privateFeatures`, `RULES.singleOrganization`). */
export function commands<T extends CommandRow & { id?: string }>(rows: readonly T[]): CommandRow[] {
  return rows
    .filter(
      (row) =>
        !isPrivateHref(row.href) &&
        !SWITCHER_HREFS.has(row.href) &&
        !OSS_ONLY_COMMAND_IDS.has(row.id ?? ""),
    )
    .map(({ label, group, href, keywords }) => ({
      label,
      group,
      href,
      ...(keywords ? { keywords } : {}),
    }));
}

/** Search results (addresses, best first) as both editions can list them: the same two rules. */
export function commandHrefs(rows: readonly { id?: string; href: string }[]): string[] {
  return rows
    .filter(
      (row) =>
        !isPrivateHref(row.href) &&
        !SWITCHER_HREFS.has(row.href) &&
        !OSS_ONLY_COMMAND_IDS.has(row.id ?? ""),
    )
    .map((row) => row.href);
}

// ── self-telemetry ────────────────────────────────────────────────────────────────────────

/** A resolved self-telemetry configuration with the service name read as one (`RULES.serviceName`). */
export function telemetryConfig(config: unknown): unknown {
  if (!config || typeof config !== "object") return config;
  const { resourceAttributes, ...rest } = config as { resourceAttributes?: Record<string, string> };
  if (!resourceAttributes) return config;
  return {
    ...rest,
    resourceAttributes: Object.fromEntries(
      Object.entries(resourceAttributes).map(([key, value]) => [
        key,
        key === "service.name" ? serviceName(value) : value,
      ]),
    ),
  };
}
