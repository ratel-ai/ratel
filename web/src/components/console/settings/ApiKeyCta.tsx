import { KeyRound, Send } from "lucide-react";
import Link from "next/link";
import { TRACES_DOCS } from "@/lib/console/docs-links";

/**
 * The API-key link of every "nothing sent yet" surface (the setup guide, the
 * Traces empty state, Agent health's states). Onboarding issues a key, so a
 * project that has one (`hasUsableApiKey`) is sent to view it, not asked to
 * create another. `className` is the button look of the surface around it.
 */
export function ApiKeyCta({
  projectId,
  hasApiKey,
  className,
  icon = false,
}: {
  projectId: string;
  hasApiKey: boolean;
  className?: string;
  icon?: boolean;
}) {
  return (
    <Link
      href={`/project/${encodeURIComponent(projectId)}/settings/api-keys`}
      className={className}
    >
      {icon && <KeyRound strokeWidth={1.5} aria-hidden />}
      {hasApiKey ? "View API keys" : "Create an API key"}
    </Link>
  );
}

/** The next step once there is a key: the docs for sending the first trace. */
export function FirstTraceLink({
  className,
  icon = false,
}: {
  className?: string;
  icon?: boolean;
}) {
  return (
    <a href={TRACES_DOCS} target="_blank" rel="noreferrer" className={className}>
      {icon && <Send strokeWidth={1.5} aria-hidden />}
      Send your first trace
    </a>
  );
}
