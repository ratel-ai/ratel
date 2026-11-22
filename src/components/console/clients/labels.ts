import type { HarnessId } from "@/lib/ingest/otlp/dimensions/client";

/**
 * The client facts (RC-773, RC-774) in plain words, for the Clients tab and
 * the span inspector. Pure, so tests and server components can call them.
 */

/** The friendly name of each harness id ingest writes. */
export const HARNESS_LABEL: Readonly<Record<HarnessId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  vscode: "VS Code",
  other: "Other",
};

export const UNKNOWN_CLIENT = "Unknown client";
export const NOT_REPORTED = "Not reported";
const UNKNOWN_COUNTRY = "Unknown";

const TRANSPORT_LABEL: Readonly<Record<string, string>> = { stdio: "stdio", http: "HTTP" };

/** A harness id as people say it; null is a call that reported no client. Unknown ids show as they are. */
export function harnessLabel(harness: string | null): string {
  if (harness === null) return UNKNOWN_CLIENT;
  return (HARNESS_LABEL as Readonly<Record<string, string>>)[harness] ?? harness;
}

/** "Claude Code 2.1.3"; the version alone is not a label. */
export function harnessWithVersion(harness: string | null, version: string | null): string {
  const label = harnessLabel(harness);
  return version ? `${label} ${version}` : label;
}

/** An ISO 3166-1 alpha-2 code with its English name ("Italy (IT)"); null is "Unknown". */
export function countryLabel(code: string | null): string {
  if (!code) return UNKNOWN_COUNTRY;
  const name = countryName(code);
  return name ? `${name} (${code.toUpperCase()})` : code.toUpperCase();
}

/** The transport a server reported ("stdio", "HTTP"), or "Not reported". */
export function transportLabel(value: string | null): string {
  if (!value) return NOT_REPORTED;
  return TRANSPORT_LABEL[value] ?? value;
}

/** Any other reported value (a protocol version), or "Not reported". */
export function reportedLabel(value: string | null): string {
  return value ? value : NOT_REPORTED;
}

let regionNames: Intl.DisplayNames | null | undefined;

function countryName(code: string): string | null {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code.toUpperCase()) ?? null;
  } catch {
    // Not a valid region code: the code alone is still worth showing.
    return null;
  }
}
