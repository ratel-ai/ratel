import { type Noun, NounIcon } from "@ratel/design-system/entity";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A section title led by its noun's mark (DESIGN.md, The product's nouns):
 * the same icon the noun wears on every page, so a heading is recognised
 * before it is read. A section about no noun (turn shapes) passes its own.
 */
export function NounTitle({
  noun,
  icon: Icon,
  children,
}: {
  noun?: Noun;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      {noun ? (
        <NounIcon noun={noun} className="size-4 text-fg-muted" />
      ) : Icon ? (
        <Icon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-fg-muted" />
      ) : null}
      {children}
    </span>
  );
}
