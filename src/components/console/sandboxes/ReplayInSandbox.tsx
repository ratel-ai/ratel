import { buttonVariants } from "@ratel/design-system/button-variants";
import { History } from "lucide-react";
import Link from "next/link";
import { getLogger } from "@/lib/platform/logger";
import { sandboxesEnabledForProject } from "@/lib/platform/sandboxes-flag";
import { sessionReplayDeps } from "@/lib/views/sandboxes/page-deps";
import { loadSessionReplayLink, type ReplayLink } from "@/lib/views/sandboxes/replay/session-page";

const logger = getLogger("sandboxes/replay-in-sandbox");

/**
 * "Replay in sandbox" on a session page (RC-1110, spec §9), only with
 * `cloud-sandboxes` on: a link to the sandbox that matches the session (by
 * `ratel.sandbox.id`, else by agent name), or, when replay is not possible, the
 * reason. Nothing renders when the flag is off or the read fails.
 */
export async function ReplayInSandbox({
  projectId,
  sessionId,
  externalId,
}: {
  projectId: string;
  sessionId: string;
  externalId: string;
}) {
  if (!(await sandboxesEnabledForProject(projectId))) return null;
  let link: ReplayLink;
  try {
    link = await loadSessionReplayLink({ projectId, externalId, sessionId }, sessionReplayDeps);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "session replay link read failed");
    return null;
  }
  if (link.state === "ready") {
    return (
      <Link
        href={link.href}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
        title={
          link.by === "sandbox_id"
            ? `Sandbox ${link.sandboxId}, matched by ratel.sandbox.id`
            : `Sandbox ${link.sandboxId}, matched by agent name`
        }
        data-replay-in-sandbox="ready"
      >
        <History aria-hidden />
        Replay in sandbox
      </Link>
    );
  }
  return (
    <span className="flex max-w-sm items-center gap-2" data-replay-in-sandbox="unavailable">
      <span
        className={buttonVariants({
          variant: "secondary",
          size: "sm",
          className: "pointer-events-none opacity-50",
        })}
        aria-disabled
      >
        <History aria-hidden />
        Replay in sandbox
      </span>
      <span className="text-xs text-fg-muted">{link.message}</span>
    </span>
  );
}
