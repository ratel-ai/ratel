import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Blocks,
  BookOpen,
  FolderKanban,
  HeartPulse,
  House,
  Settings,
} from "lucide-react";
import type { NavIconName } from "@/lib/console/navigation";

/** One glyph per rail item, kept out of the navigation model so it stays testable. */
export const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  overview: House,
  health: HeartPulse,
  catalog: BookOpen,
  traces: Activity,
  settings: Settings,
  projects: FolderKanban,
  edition: Blocks,
};
