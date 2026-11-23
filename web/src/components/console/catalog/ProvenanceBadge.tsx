import { Badge, StatusDot } from "@ratel/design-system/badge";
import { Cloud, Eye, type LucideIcon, Plug } from "lucide-react";
import type { CatalogProvenance, SkillStatus } from "@/lib/console/catalog/items";
import { APP_NAME } from "@/lib/platform/app-config";

const PROVENANCE: Record<CatalogProvenance, { label: string; icon: LucideIcon; hint: string }> = {
  managed: { label: "Managed", icon: Plug, hint: "Synced from your runtime." },
  observed: { label: "Observed", icon: Eye, hint: "Seen in traces only." },
  cloud: { label: `${APP_NAME}`, icon: Cloud, hint: `Created here in ${APP_NAME}.` },
};

/** Where an item's definition comes from, as a word with a shape: a plug, an eye or a cloud. */
export function ProvenanceBadge({ provenance }: { provenance: CatalogProvenance }) {
  const { label, icon: Icon } = PROVENANCE[provenance];
  return (
    <Badge>
      <Icon aria-hidden strokeWidth={1.5} />
      {label}
    </Badge>
  );
}

/** The one-line meaning of a provenance, for a detail's subtitle. */
export function provenanceHint(provenance: CatalogProvenance): string {
  return PROVENANCE[provenance].hint;
}

const STATUS: Record<SkillStatus, { tone: "success" | "neutral"; label: string }> = {
  published: { tone: "success", label: "Published" },
  draft: { tone: "neutral", label: "Draft" },
  archived: { tone: "neutral", label: "Archived" },
};

/** A Cloud skill's lifecycle, as a dot and its word. */
export function SkillStatusDot({ status }: { status: SkillStatus }) {
  return <StatusDot tone={STATUS[status].tone} label={STATUS[status].label} />;
}
