import type { LucideIcon } from "lucide-react";
import { Activity, Blocks, House, Settings, Wrench } from "lucide-react";
import type { NavIconName } from "@/lib/console/navigation";

/** One glyph per rail item, kept out of the navigation model so it stays testable. */
export const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  overview: House,
  tools: Wrench,
  calls: Activity,
  settings: Settings,
  edition: Blocks,
};
