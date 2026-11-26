import type { ReactNode } from "react";
import type { ApiKeyCta } from "@/lib/console/api-key-cta";
import { loadApiKeyCta } from "@/lib/console/api-key-cta-load";

/**
 * The server half of the API-key CTA: reads the project's keys
 * (`loadApiKeyCta`, once per request) and hands the decided CTA to `children`.
 * A component that draws `ApiKeyCta` wraps itself in this when it is not given
 * one, so its page passes only the project id; tests pass the CTA instead.
 *
 * An async Server Component: it renders only where it is placed, so a slot a
 * page never shows never reads the keys.
 */
export async function WithApiKeyCta({
  projectId,
  children,
}: {
  projectId: string;
  children: (cta: ApiKeyCta) => ReactNode;
}) {
  return children(await loadApiKeyCta(projectId));
}
