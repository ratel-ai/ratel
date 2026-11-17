import type { Tone } from "@ratel/design-system/badge";
import { formatDay, formatStamp, relativeTime } from "@/lib/console/settings/format";
import type { ApiKeySummary } from "@/lib/platform/api-key-actions";
import type { ApiKeyStatus } from "@/lib/platform/api-keys";
import {
  API_KEY_PRESET_INFO,
  API_KEY_SCOPE_INFO,
  type ApiKeyAccess,
  isApiKeyScope,
} from "@/lib/platform/api-keys/scopes";

/** Status is a dot and a word (DESIGN.md, Color). */
export const API_KEY_STATUS: Record<
  ApiKeyStatus,
  { tone: Exclude<Tone, "accent">; label: string }
> = {
  active: { tone: "success", label: "Active" },
  expired: { tone: "warning", label: "Expired" },
  revoked: { tone: "neutral", label: "Revoked" },
};

export interface ApiKeyRow {
  id: string;
  name: string;
  /** False when the key has no name and the row shows the fallback. */
  named: boolean;
  /** How dialogs and buttons name the key: its name, or its prefix when it has none. */
  label: string;
  prefix: string;
  created: string;
  createdTitle: string;
  lastUsed: string;
  /** Absolute time behind the relative one; null when never used. */
  lastUsedTitle: string | null;
  expires: string;
  status: (typeof API_KEY_STATUS)[ApiKeyStatus];
  access: ApiKeyAccessView;
}

export interface ApiKeyAccessView {
  label: string;
  tone: Tone;
  /** The permissions in words, for the cell's title. */
  detail: string;
  /** Ingest-only: the one kind safe to put in an app. */
  publishable: boolean;
}

const ACCESS_TONE: Record<ApiKeyAccess, Tone> = {
  full: "neutral",
  read_only: "info",
  ingest: "success",
  custom: "neutral",
};

/** How a key's access reads in the list: its preset, or how many permissions. */
export function apiKeyAccessView(
  key: Pick<ApiKeySummary, "access" | "scopes" | "publishable">,
): ApiKeyAccessView {
  const permissions = key.scopes
    .filter(isApiKeyScope)
    .map((scope) => API_KEY_SCOPE_INFO[scope].label);
  const label =
    key.access === "custom"
      ? `Custom (${permissions.length} ${permissions.length === 1 ? "permission" : "permissions"})`
      : API_KEY_PRESET_INFO[key.access].label;
  const detail = key.access === "full" ? "Everything a key can do" : permissions.join(", ");
  return { label, tone: ACCESS_TONE[key.access], detail, publishable: key.publishable };
}

/** One key as its table row reads: no secrets, every date in words. */
export function apiKeyRow(key: ApiKeySummary, now: Date): ApiKeyRow {
  return {
    id: key.id,
    name: key.name ?? "Unnamed key",
    named: key.name !== null,
    label: apiKeyDisplayName(key),
    prefix: key.keyPrefix,
    created: formatDay(key.createdAt),
    createdTitle: formatStamp(key.createdAt),
    lastUsed: key.lastUsedAt ? relativeTime(key.lastUsedAt, now) : "Never",
    lastUsedTitle: key.lastUsedAt ? formatStamp(key.lastUsedAt) : null,
    expires: key.expiresAt ? formatDay(key.expiresAt) : "Never",
    status: API_KEY_STATUS[key.status],
    access: apiKeyAccessView(key),
  };
}

/** The name a dialog or toast uses for a key: its own, or its prefix. */
export function apiKeyDisplayName(key: Pick<ApiKeySummary, "name" | "keyPrefix">): string {
  return key.name ?? `${key.keyPrefix}…`;
}

/**
 * Closing the step that shows a new key. Its plaintext exists only there, so
 * the dialog asks once before it lets go of an uncopied key; a second close
 * (Esc again, the close button) means the person is sure.
 */
export function newKeyCloseDecision(state: { copied: boolean; asking: boolean }): "close" | "ask" {
  return state.copied || state.asking ? "close" : "ask";
}
