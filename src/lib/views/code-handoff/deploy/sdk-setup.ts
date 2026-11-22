import type { Organization } from "@/lib/contracts/session";
import { codeHandoffEnabledFor } from "../gate";

/**
 * Whether the app's SDK setup copy asks for `service.version` = the deployed
 * commit sha (RC-995): `FF_CODE_HANDOFF` in the project's organization.
 * Decided on the server, once per page; the copy components take a boolean.
 *
 * Owned (ADR-0030): the switch is the core's `FF_CODE_HANDOFF` (`featureEnabled`), which never
 * throws (a failed decision is off), in place of upstream's organization flag read with its
 * catch-and-log.
 */
export function showDeployVersionGuidance(organization: Pick<Organization, "id">): Promise<boolean> {
  return codeHandoffEnabledFor(organization);
}
