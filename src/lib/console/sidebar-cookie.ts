export const SIDEBAR_COLLAPSED_COOKIE = "ratel_sidebar_collapsed";

const COOKIE_MAX_AGE_SECONDS = 31_536_000;

export function parseSidebarCollapsedCookie(value: string | null | undefined): boolean {
  return value === "1";
}

export function serializeSidebarCollapsedCookie(collapsed: boolean): string {
  return [
    `${SIDEBAR_COLLAPSED_COOKIE}=${collapsed ? "1" : "0"}`,
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ].join("; ");
}
