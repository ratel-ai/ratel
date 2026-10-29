import type { NavItem as EditionNavItem } from "@/lib/composition/ports";
import type { ConsoleAccount, ConsoleProject } from "@/lib/console/shell-data";

/** Everything the client frame needs, resolved once per request on the server. */
export type ShellData = {
  organizationName: string | null;
  organizationSlug: string | null;
  projects: ConsoleProject[];
  /** Null without a session. */
  account: ConsoleAccount | null;
  /** Destinations the edition adds (`composition.nav`). */
  editionNav: EditionNavItem[];
  initiallyCollapsed: boolean;
};
