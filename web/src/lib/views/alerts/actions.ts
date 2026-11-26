import { parseProjectUuid } from "@/lib/console/scope/cookie";
import type { MetricFeatures } from "@/lib/synthesis/metrics/catalog";
import { parseRule } from "@/lib/views/alerts/parse-rule";
import type * as store from "@/lib/views/alerts/store";
import { type AlertDraft, MAX_ALERT_RULES } from "@/lib/views/alerts/types";

export type AlertActionInput = { projectId: string } & (
  | { action: "create"; draft: AlertDraft }
  | { action: "update"; ruleId: string; draft: AlertDraft }
  | { action: "set_enabled"; ruleId: string; enabled: boolean }
  | { action: "delete"; ruleId: string }
);

export type AlertActionResult = { ok: true; ruleId: string } | { ok: false; error: string };

/** Who may act on which project: every alert action passes through it. */
export interface AlertAccessDeps {
  getSession(): Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope(
    projectId: string,
    userId: string,
  ): Promise<{ project: { id: string }; organization: { id: string } } | null>;
  enabled(subject: AlertSubject): Promise<boolean>;
  /** An admin support session may look but not change. */
  isRestricted(): Promise<boolean>;
}

export interface AlertSubject {
  projectId: string;
  organizationId: string;
  actor: string;
}

export interface AlertActionDeps extends AlertAccessDeps {
  /** The switches that decide which metrics a rule may use. */
  features(subject: AlertSubject): Promise<MetricFeatures>;
  store: Pick<
    typeof store,
    "createAlertRule" | "updateAlertRule" | "setAlertRuleEnabled" | "deleteAlertRule"
  >;
  observe(fields: {
    project_id: string;
    organization_id: string;
    rule_id: string;
    actor: string;
    action: AlertActionInput["action"];
  }): Promise<void>;
}

const INVALID = { ok: false, error: "The alert change is invalid." } as const;
const MISSING = { ok: false, error: "This alert no longer exists." } as const;

/** One change to a project's alert rules: membership and the flag first, then the rule itself. */
export async function changeAlert(raw: unknown, deps: AlertActionDeps): Promise<AlertActionResult> {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const access = await authorizeAlerts(input.projectId, deps);
  if (!access.ok) return access;
  const { subject } = access;
  const { projectId, actor } = subject;

  const ruleId = uuidOf(input.ruleId);
  let id: string;
  switch (input.action) {
    case "create":
    case "update": {
      const parsed = parseRule(input.draft, await deps.features(subject));
      if (!parsed.ok) return parsed;
      if (input.action === "create") {
        const created = await deps.store.createAlertRule(projectId, parsed.draft, actor);
        if (created === null)
          return { ok: false, error: `A project can have ${MAX_ALERT_RULES} alerts.` };
        id = created;
      } else {
        if (!ruleId) return INVALID;
        if (!(await deps.store.updateAlertRule(projectId, ruleId, parsed.draft, actor)))
          return MISSING;
        id = ruleId;
      }
      break;
    }
    case "set_enabled": {
      if (!ruleId || typeof input.enabled !== "boolean") return INVALID;
      if (!(await deps.store.setAlertRuleEnabled(projectId, ruleId, input.enabled, actor)))
        return MISSING;
      id = ruleId;
      break;
    }
    case "delete": {
      if (!ruleId) return INVALID;
      if (!(await deps.store.deleteAlertRule(projectId, ruleId))) return MISSING;
      id = ruleId;
      break;
    }
    default:
      return INVALID;
  }
  await deps.observe({
    project_id: projectId,
    organization_id: subject.organizationId,
    rule_id: id,
    actor,
    action: input.action,
  });
  return { ok: true, ruleId: id };
}

/** Require a session, project membership, the project's flag and no support session. */
export async function authorizeAlerts(
  rawProjectId: unknown,
  deps: AlertAccessDeps,
): Promise<{ ok: true; subject: AlertSubject } | { ok: false; error: string }> {
  const projectId = uuidOf(rawProjectId);
  if (!projectId) return INVALID;
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to change alerts." };
  const scope = await deps.findProjectScope(projectId, session.user.id);
  if (!scope) return { ok: false, error: "You cannot change this project's alerts." };
  const subject = {
    projectId: scope.project.id,
    organizationId: scope.organization.id,
    actor: session.user.externalId,
  };
  if (!(await deps.enabled(subject)))
    return { ok: false, error: "Alerts are off for this project." };
  if (await deps.isRestricted())
    return { ok: false, error: "A support session cannot change alerts." };
  return { ok: true, subject };
}

function uuidOf(raw: unknown): string | null {
  return typeof raw === "string" ? parseProjectUuid(raw) : null;
}
