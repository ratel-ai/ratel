import { composition } from "@/lib/composition/ports";
import type { ApiKeyCreationPort } from "@/lib/contracts/api-key-creation";
import { getLogger } from "@/lib/platform/logger";
import { projectOnHold, readHolds } from "@/lib/platform/org-hold/state";

/** The core's side of the `apiKeyCreation` port (`lib/contracts/api-key-creation.ts`). */

const logger = getLogger("api-key-creation");

export interface ApiKeyCreationDeps {
  port?: ApiKeyCreationPort;
  now?: () => Date;
  /** Whether the organization, or the project when one is named, is on hold. */
  onHold?: (organizationId: string, projectId?: string) => Promise<boolean>;
}

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

/** The note on the keys page, and the refusal: the same words and date. */
export function keysBlockedMessage(until: Date): string {
  return `New API keys become available on ${DATE.format(until)} UTC. This workspace moved recently. Existing keys keep working.`;
}

/** When the organization's new keys become available, or null when they are. */
export async function apiKeysBlockedUntil(
  organizationId: string,
  { port = composition.apiKeyCreation, now = () => new Date() }: ApiKeyCreationDeps = {},
): Promise<Date | null> {
  const until = (await port?.blockedUntil(organizationId)) ?? null;
  return until && until.getTime() > now().getTime() ? until : null;
}

/**
 * Why a key may not be made now, or null. A check that fails refuses: a key made by mistake cannot
 * be taken back, and the person can try again.
 */
export async function apiKeyCreationRefusal(
  organizationId: string,
  projectId?: string,
  deps: ApiKeyCreationDeps = {},
): Promise<string | null> {
  try {
    if (await (deps.onHold ?? storedHold)(organizationId, projectId)) {
      return "This workspace is not open yet. Try again later.";
    }
    const until = await apiKeysBlockedUntil(organizationId, deps);
    return until ? keysBlockedMessage(until) : null;
  } catch (err) {
    logger.error({ err, org_id: organizationId }, "api key creation check failed");
    return "We couldn't check whether this workspace may have new API keys. Try again shortly.";
  }
}

async function storedHold(organizationId: string, projectId?: string): Promise<boolean> {
  if (projectId) return projectOnHold({ id: projectId, organizationId });
  return (await readHolds()).organizations.has(organizationId);
}
