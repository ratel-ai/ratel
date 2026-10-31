import Link from "next/link";
import type { ReactNode } from "react";

export const STATUS_LINK_CLASS_NAME =
  "inline-flex h-9 items-center justify-center rounded-lg bg-cream px-4 text-sm font-medium text-base-deep shadow-sm transition-colors hover:bg-cream-dim";

export function StatusLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={STATUS_LINK_CLASS_NAME}>
      {children}
    </Link>
  );
}
