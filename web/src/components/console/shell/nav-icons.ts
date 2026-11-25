import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Blocks,
  BookOpen,
  Building2,
  Cable,
  CreditCard,
  Crosshair,
  Database,
  HeartPulse,
  House,
  ListChecks,
  Orbit,
  Plug,
  Rocket,
  RotateCcw,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import type { NavIconName } from "@/lib/console/navigation";

/** One glyph per rail item, kept out of the navigation model so it stays testable. */
export const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  overview: House,
  health: HeartPulse,
  tasks: ListChecks,
  intents: Orbit,
  improvements: Sparkles,
  catalog: BookOpen,
  traces: Activity,
  settings: Settings,
  projects: Building2,
  integrations: Cable,
  members: Users,
  billing: CreditCard,
  embeddings: Database,
  "tool-picker": Crosshair,
  ship: Rocket,
  "self-corrections": RotateCcw,
  apis: Plug,
  edition: Blocks,
};
