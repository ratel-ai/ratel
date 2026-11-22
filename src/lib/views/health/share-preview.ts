/** User agents of link unfurlers and crawlers: their loads are not counted as views of a shared page. */
const PREVIEW_AGENT =
  /bot|crawler|spider|preview|slack|discord|whatsapp|telegram|facebookexternalhit|embedly|skype|teams/i;

export function isLinkPreviewAgent(userAgent: string | null | undefined): boolean {
  return PREVIEW_AGENT.test(userAgent ?? "");
}
