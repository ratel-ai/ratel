import type { NavItem as EditionNavItem } from "@/lib/composition/ports";
import type { ConsoleProject } from "@/lib/console/shell-data";

/** Everything the client frame needs, resolved once per request on the server. */
export type ShellData = {
  organizationName: string | null;
  projects: ConsoleProject[];
  /** Destinations the edition adds (`composition.nav`). */
  editionNav: EditionNavItem[];
  initiallyCollapsed: boolean;
};
