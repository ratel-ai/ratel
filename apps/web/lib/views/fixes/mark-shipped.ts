import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getLogger } from "@/lib/platform/logger";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException } from "@/lib/platform/telemetry";
import { loadFixes } from "@/lib/views/fixes/load";
import {
  defaultRecordFixShipmentDeps,
  type RecordFixShipmentDeps,
  recordFixShipment,
  shipmentFields,
} from "@/lib/views/fixes/record-shipment";
import { findFix } from "@/lib/views/fixes/select";
import type { FixesModel } from "@/lib/views/fixes/types";

/**
 * Mark as shipped on a fix's panel. Any member of the project may, as with
 * Dismiss and `mark_fix_shipped`. Membership and the fix are resolved here;
 * the client posts only the ids and the form fields. The recording is
 * `recordFixShipment`, shared with the MCP tool, and it follows
 * `cloud-eval-gate` itself: off, it stores the shipment and queues no measure.
 */

const logger = getLogger("fixes/mark-shipped");

export interface MarkFixShippedInput {
  projectId: string;
  fixId: string;
  version: string;
  notes?: string;
}

export type MarkFixShippedResult =
  | { ok: true; version: string; shipmentId: string }
  | { ok: false; message: string };

export interface MarkFixShippedDeps extends RecordFixShipmentDeps {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findScope: (projectId: string, userId: string) => ReturnType<typeof findProjectScope>;
  /** Every fix of the project, open or applied. */
  loadProjectFixes: (projectId: string) => Promise<FixesModel | null>;
  revalidate: (path: string) => void;
}

const DENIED: MarkFixShippedResult = {
  ok: false,
  message: "This fix can't be marked as shipped here.",
};

export async function markFixShipped(
  input: MarkFixShippedInput,
  deps: MarkFixShippedDeps = defaultDeps,
): Promise<MarkFixShippedResult> {
  const { projectId, fixId } = input;
  if (typeof projectId !== "string" || typeof fixId !== "string") return DENIED;
  const fields = shipmentFields.safeParse({ version: input.version, notes: input.notes });
  if (!fields.success) {
    const field = fields.error.issues[0]?.path[0];
    return {
      ok: false,
      message:
        field === "notes"
          ? "Notes can be up to 1000 characters."
          : "Enter a version of 1 to 100 characters.",
    };
  }
  const session = await deps.getSession();
  if (!session) return DENIED;
  const scope = await deps.findScope(projectId, session.user.id);
  if (!scope) return DENIED;
  try {
    const model = await deps.loadProjectFixes(scope.project.id);
    const fix = model ? findFix([...model.open, ...model.applied], fixId) : null;
    if (!fix) return DENIED;
    const notes = fields.data.notes?.trim() || null;
    const { row } = await recordFixShipment(
      {
        projectId: scope.project.id,
        fix,
        experiment: null,
        version: fields.data.version,
        notes,
        shippedBy: session.user.externalId,
        actor: {
          externalId: session.user.externalId,
          orgId: scope.organization.id,
          projectId: scope.project.id,
        },
        surface: "fixes",
      },
      deps,
    );
    deps.revalidate(`/project/${scope.project.id}/improvement/fixes`);
    deps.revalidate(`/project/${scope.project.id}/ship`);
    return { ok: true, version: row.version, shipmentId: row.id };
  } catch (err) {
    logger.error({ err, project_id: scope.project.id, fix_id: fixId }, "fix shipment failed");
    reportServerException(err, session.user.externalId, {
      project_id: scope.project.id,
      operation: "fix_mark_shipped",
    });
    return { ok: false, message: "Couldn't mark the fix as shipped. Try again in a moment." };
  }
}

const defaultDeps: MarkFixShippedDeps = {
  getSession: async () => {
    const session = await getSessionContext();
    return session ? { user: { id: session.user.id, externalId: session.user.externalId } } : null;
  },
  findScope: findProjectScope,
  loadProjectFixes: async (projectId) => {
    const organization = await getOrganizationByProjectId(projectId);
    return organization ? loadFixes({ projectId, organization }) : null;
  },
  revalidate: revalidatePath,
  ...defaultRecordFixShipmentDeps,
};
