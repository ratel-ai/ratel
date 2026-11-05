import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Blocks,
  BookOpen,
  Cable,
  CreditCard,
  Crosshair,
  Database,
  FolderKanban,
  HeartPulse,
  House,
  Orbit,
  Rocket,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import type { NavIconName } from "@/lib/console/navigation";

/** One glyph per rail item, kept out of the navigation model so it stays testable. */
export const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  overview: House,
  health: HeartPulse,
  intents: Orbit,
  improvements: Sparkles,
  catalog: BookOpen,
  traces: Activity,
  settings: Settings,
  projects: FolderKanban,
  integrations: Cable,
  members: Users,
  billing: CreditCard,
  embeddings: Database,
  "tool-picker": Crosshair,
  ship: Rocket,
  edition: Blocks,
};
