import type { ReactNode } from "react";
import type {
  NavItem as EditionNavItem,
  OrganizationNavItem,
  ProjectNavGroup,
} from "@/lib/composition/ports";
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
  /** Organization pages the edition adds (`composition.organizationNav`). */
  organizationNav: OrganizationNavItem[];
  /** Project page groups the edition adds (`composition.projectNav`). */
  projectNav: ProjectNavGroup[];
  /** The edition's rail switcher, rendered on the server for each rail width; the project switcher otherwise. */
  scopeSwitcher: { expanded: ReactNode; collapsed: ReactNode } | null;
  /** Menu items the edition adds to the account menu, rendered on the server. */
  accountMenuItems: ReactNode;
  initiallyCollapsed: boolean;
};
