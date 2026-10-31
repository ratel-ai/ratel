import { NOUN_ICONS } from "@ratel/design-system/entity";
import {
  Archive,
  BookPlus,
  Braces,
  Columns2,
  Diff,
  FoldHorizontal,
  Layers,
  ListFilter,
  ListOrdered,
  ListPlus,
  ListStart,
  type LucideIcon,
  Merge,
  PackagePlus,
  PenLine,
  ShieldAlert,
  SlidersHorizontal,
  Split,
} from "lucide-react";
import type { FixGroup } from "@/lib/views/fixes/groups";
import type { FixKind } from "@/lib/views/fixes/kinds";

/**
 * One small mark per kind of fix, so a row says what to do before it is
 * read: a rewrite is a pen, a merge two lines joining, a retirement an
 * archive box. Each table's heading wears its group's mark; a tool change is
 * the tool's own wrench (NOUN_ICONS).
 */
export const FIX_KIND_ICONS: Readonly<Record<FixKind, LucideIcon>> = {
  rewrite: PenLine,
  "tell-apart": Diff,
  retire: Archive,
  merge: Merge,
  combine: Layers,
  build: PackagePlus,
  skill: BookPlus,
  "fail-clearly": ShieldAlert,
  schema: Braces,
  fold: FoldHorizontal,
  parallel: Columns2,
  enrich: ListPlus,
  preload: ListStart,
  split: Split,
  prerequisite: ListOrdered,
  "fewer-results": ListFilter,
};

export const FIX_GROUP_ICONS: Readonly<Record<FixGroup, LucideIcon>> = {
  descriptions: PenLine,
  tools: NOUN_ICONS.tool,
  skills: BookPlus,
  ranking: SlidersHorizontal,
};
