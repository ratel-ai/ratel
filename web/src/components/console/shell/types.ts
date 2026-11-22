import type { ReactNode } from "react";
import type {
  NavItem as EditionNavItem,
  OrganizationNavItem,
  ProjectNavGroup,
} from "@/lib/composition/ports";
import type { ConsoleAccount, ConsoleOrganization, ConsoleProject } from "@/lib/console/shell-data";
import type { EditionCommandAction } from "@/lib/contracts/composition";

/** Everything the client frame needs, resolved once per request on the server. */
export type ShellData = {
  /** The session's active organization: the shell's fallback when the route names none. */
  organizationName: string | null;
  organizationSlug: string | null;
  /** Every organization the reader belongs to; the frame shows the one `shellOrganization` picks. */
  organizations: ConsoleOrganization[];
  /** The projects of every organization the reader belongs to. */
  projects: ConsoleProject[];
  /** Null without a session. */
  account: ConsoleAccount | null;
  /** Destinations the edition adds (`composition.nav`). */
  editionNav: EditionNavItem[];
  /** Organization pages the edition adds (`composition.organizationNav`). */
  organizationNav: OrganizationNavItem[];
  /** The edition's `hiddenOrganizationNav` paths, per organization slug. */
  hiddenOrganizationNav: Record<string, readonly string[]>;
  /** Project page groups the edition adds (`composition.projectNav`). */
  projectNav: ProjectNavGroup[];
  /** The organizations with `FF_AGENTS_PAGES` on: their rail shows Agents and MCP servers under Traces. */
  entityPagesOrganizations?: readonly string[];
  /** The edition's rail switcher, rendered on the server for each rail width; the project switcher otherwise. */
  scopeSwitcher: { expanded: ReactNode; collapsed: ReactNode } | null;
  /** Menu items the edition adds to the account menu, rendered on the server. */
  accountMenuItems: ReactNode;
  /** Menu items the edition adds after the shortcuts, rendered on the server; none otherwise. */
  accountMenuEndItems?: ReactNode;
  /** The edition's overlays, rendered on the server and mounted once after the shell's dialogs; null otherwise. */
  overlays?: ReactNode;
  /** Command palette entries the edition adds; none otherwise. */
  commandActions?: readonly EditionCommandAction[];
  initiallyCollapsed: boolean;
  /** The edition's product name (`lib/platform/product-name`): the mobile bar's fallback title. */
  productName: string;
};
