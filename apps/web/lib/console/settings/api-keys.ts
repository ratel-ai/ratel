import type { Tone } from "@ratel/design-system/badge";
import { formatDay, formatStamp, relativeTime } from "@/lib/console/settings/format";
import type { ApiKeySummary } from "@/lib/platform/api-key-actions";
import type { ApiKeyStatus } from "@/lib/platform/api-keys";

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
