import { z } from "zod";
import {
  TRAINING_CONSENT_TERMS,
  TRAINING_CONSENT_TITLE,
  TRAINING_CONSENT_VERSION,
} from "@/lib/console/onboarding/training-consent";
import { getLogger } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { CONSENT_REJECTIONS, consentView } from "./domain/consent";
import type { ConsentStore, DatasetStore } from "./ports/store";

/**
 * `/api/projects/<id>/fine-tuning/consent` (RC-1123): read, give (`POST`) or
 * withdraw (`DELETE`) the training opt-in of one project. A member reads it;
 * only an admin of the project's organization changes it. Behind
 * `FF_FINE_TUNING`: off, the route is not found, as the page is. A
 * withdrawal deletes every dataset of the project. Store errors propagate to
 * `withRequestLog()`, which logs them and answers 500.
 */

export type ConsentEvent =
  | {
      name: "training_consent_given";
      externalId: string;
      projectId: string;
      organizationId: string;
      textVersion: string;
    }
  | {
      name: "training_consent_withdrawn";
      externalId: string;
      projectId: string;
      organizationId: string;
      textVersion: string;
      datasetsDeleted: number;
    };

export interface ConsentApiDeps {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: Project; organization: Organization; role: string } | null>;
  fineTuningEnabled: (organization: Organization) => Promise<boolean>;
  /** An admin support session may look but not change. */
  isRestricted: () => Promise<boolean>;
  consents: () => ConsentStore;
  datasets: () => Pick<DatasetStore, "deleteDatasets">;
  track: (event: ConsentEvent) => Promise<void>;
}

const logger = getLogger("fine-tuning/consent-api");
const GiveBody = z.object({ textVersion: z.string().trim().min(1).max(64) }).strict();

export async function handleConsentRequest(
  request: Request,
  projectId: string,
  deps: ConsentApiDeps,
): Promise<Response> {
  const session = await deps.getSession();
  if (!session)
    return json(401, {
      ok: false,
      error: "signed_out",
      message: "Sign in to see the training opt-in.",
    });
  const scope = await deps.findProjectScope(projectId, session.user.id);
  if (!scope || !(await deps.fineTuningEnabled(scope.organization))) {
    return json(404, {
      ok: false,
      error: "not_found",
      message: "No project you belong to has that ID.",
    });
  }
  const { project, organization } = scope;
  const canEdit = scope.role === "admin";

  if (request.method === "GET") {
    const consent = await deps.consents().getActiveConsent(project.id);
    return json(200, { ok: true, consent: consentView(consent), text: consentText(), canEdit });
  }

  if (!canEdit)
    return json(403, {
      ok: false,
      error: "not_admin",
      message: "Only organization admins can change the training opt-in.",
    });
  if (await deps.isRestricted())
    return json(403, {
      ok: false,
      error: "restricted",
      message: "A support session cannot change the training opt-in.",
    });
  const actor = session.user.externalId;
  const event = { externalId: actor, projectId: project.id, organizationId: organization.id };

  if (request.method === "DELETE") {
    const withdrawn = await deps.consents().withdrawConsent(project.id, actor);
    // Always: a retry after a failed delete still removes what the first call left.
    const datasetsDeleted = await deps.datasets().deleteDatasets(project.id);
    if (!withdrawn) {
      logger.info(
        { project_id: project.id, datasets_deleted: datasetsDeleted, outcome: "not_given" },
        "training consent withdrawal refused",
      );
      return json(409, { ok: false, error: "not_given", message: CONSENT_REJECTIONS.not_given });
    }
    logger.info(
      { project_id: project.id, datasets_deleted: datasetsDeleted, outcome: "withdrawn" },
      "training consent withdrawn",
    );
    await deps.track({
      name: "training_consent_withdrawn",
      ...event,
      textVersion: withdrawn.textVersion,
      datasetsDeleted,
    });
    return json(200, { ok: true, consent: consentView(null), datasetsDeleted });
  }

  const parsed = GiveBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return json(400, {
      ok: false,
      error: "invalid",
      message: parsed.error.issues[0]?.message ?? "Invalid opt-in.",
    });
  if (parsed.data.textVersion !== TRAINING_CONSENT_VERSION) {
    return json(409, { ok: false, error: "stale_text", message: CONSENT_REJECTIONS.stale_text });
  }
  const { consent, created } = await deps
    .consents()
    .giveConsent(project.id, actor, TRAINING_CONSENT_VERSION);
  logger.info(
    { project_id: project.id, outcome: created ? "given" : "already_given" },
    "training consent given",
  );
  if (created)
    await deps.track({
      name: "training_consent_given",
      ...event,
      textVersion: consent.textVersion,
    });
  return json(200, { ok: true, consent: consentView(consent) });
}

/** The copy the admin agrees to, with its version. */
export function consentText() {
  return {
    version: TRAINING_CONSENT_VERSION,
    title: TRAINING_CONSENT_TITLE,
    terms: TRAINING_CONSENT_TERMS,
  };
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
