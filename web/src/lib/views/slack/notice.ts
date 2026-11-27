import { SLACK_CODE } from "@/lib/views/slack/api";
import { INSTALL_NOTICES, type InstallNotice } from "@/lib/views/slack/types";

/** How an install ended, from the page's address; null: nothing to tell. */
export function installNotice(
  query: Record<string, string | string[] | undefined>,
): { ok: boolean; text: string } | null {
  const { slack, reason } = query;
  if (typeof slack !== "string" || !Object.hasOwn(INSTALL_NOTICES, slack)) return null;
  const text = INSTALL_NOTICES[slack as InstallNotice];
  if (slack === "connected") return { ok: true, text };
  const code = typeof reason === "string" && SLACK_CODE.test(reason) ? ` (${reason})` : "";
  return { ok: false, text: `${text}${code}` };
}
