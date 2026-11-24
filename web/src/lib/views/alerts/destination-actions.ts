import { parseProjectUuid } from "@/lib/console/scope/cookie";
import {
  type AlertAccessDeps,
  type AlertSubject,
  authorizeAlerts,
} from "@/lib/views/alerts/actions";
import { MAX_DESTINATIONS, type SealedDestination } from "@/lib/views/alerts/destinations";
import { slackTestMessage } from "@/lib/views/alerts/slack-message";
import { parseSlackWebhook } from "@/lib/views/alerts/slack-url";
import { MAX_DESTINATION_NAME } from "@/lib/views/alerts/types";
import type { PostResult } from "@/lib/views/alerts/webhook-post";

export type DestinationActionInput = { projectId: string } & (
  | { action: "add"; name: string; url: string }
  | { action: "test"; destinationId: string }
  | { action: "remove"; destinationId: string }
);

export type DestinationActionResult =
  | { ok: true; destinationId: string }
  | { ok: false; error: string };

export interface DestinationActionDeps extends AlertAccessDeps {
  /** Whether this deployment can keep secrets. */
  canSeal(): boolean;
  count(projectId: string): Promise<number>;
  create(input: { projectId: string; name: string; url: URL; actor: string }): Promise<string>;
  remove(projectId: string, id: string): Promise<boolean>;
  sealed(projectId: string, id: string): Promise<SealedDestination | null>;
  post(destination: SealedDestination, message: { text: string }): Promise<PostResult>;
  projectName(projectId: string): Promise<string>;
  observe(fields: {
    project_id: string;
    organization_id: string;
    destination_id: string;
    actor: string;
    action: DestinationActionInput["action"];
    outcome: "ok" | "failed";
  }): Promise<void>;
}

const INVALID = { ok: false, error: "The destination is invalid." } as const;
const MISSING = { ok: false, error: "This destination no longer exists." } as const;

/** Add, test or remove a Slack destination. No result ever holds the URL. */
export async function changeDestination(
  raw: unknown,
  deps: DestinationActionDeps,
): Promise<DestinationActionResult> {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const access = await authorizeAlerts(input.projectId, deps);
  if (!access.ok) return access;
  const { subject } = access;
  const { action } = input;
  if (action !== "add" && action !== "test" && action !== "remove") return INVALID;

  const id = text(input.destinationId);
  const result =
    action === "add"
      ? await add(input, subject, deps)
      : !id
        ? INVALID
        : action === "test"
          ? await sendTest(id, subject, deps)
          : (await deps.remove(subject.projectId, id))
            ? { ok: true as const, destinationId: id }
            : MISSING;
  const destinationId = result.ok ? result.destinationId : id;
  if (destinationId)
    await deps.observe({
      project_id: subject.projectId,
      organization_id: subject.organizationId,
      destination_id: destinationId,
      actor: subject.actor,
      action,
      outcome: result.ok ? "ok" : "failed",
    });
  return result;
}

async function add(
  input: Record<string, unknown>,
  { projectId, actor }: AlertSubject,
  deps: DestinationActionDeps,
): Promise<DestinationActionResult> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Give the destination a name." };
  if (name.length > MAX_DESTINATION_NAME)
    return { ok: false, error: `A name can have ${MAX_DESTINATION_NAME} characters.` };
  const url = parseSlackWebhook(input.url);
  if (!url)
    return {
      ok: false,
      error: "Use an incoming webhook URL that starts with https://hooks.slack.com/.",
    };
  if (!deps.canSeal())
    return {
      ok: false,
      error: "This deployment cannot store secrets. Set RATEL_SECRET_KEY and restart it.",
    };
  if ((await deps.count(projectId)) >= MAX_DESTINATIONS)
    return { ok: false, error: `A project can have ${MAX_DESTINATIONS} destinations.` };
  return { ok: true, destinationId: await deps.create({ projectId, name, url, actor }) };
}

async function sendTest(
  id: string,
  { projectId }: AlertSubject,
  deps: DestinationActionDeps,
): Promise<DestinationActionResult> {
  const destination = await deps.sealed(projectId, id);
  if (!destination) return MISSING;
  const message = slackTestMessage(destination.name, await deps.projectName(projectId));
  const result = await deps.post(destination, message);
  return result.ok ? { ok: true, destinationId: id } : result;
}

function text(raw: unknown): string | null {
  return typeof raw === "string" ? parseProjectUuid(raw) : null;
}
