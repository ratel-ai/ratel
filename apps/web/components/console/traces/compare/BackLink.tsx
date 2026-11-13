import Link from "next/link";
import type { ReactNode } from "react";

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex w-fit items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted transition-colors hover:text-cream"
    >
      <span aria-hidden>←</span>
      {children}
    </Link>
  );
}
