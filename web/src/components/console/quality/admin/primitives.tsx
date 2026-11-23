import { cn } from "@ratel/design-system/cn";
import type { ReactNode } from "react";

/**
 * Server-safe presentational primitives for the admin console (no client hooks): section
 * headers and cards. Styled with the shared brand tokens (cream / forest / coral) so the console
 * reads like the rest of the product without importing the customer dashboard's data-coupled
 * components.
 *
 * Owned (ADR-0004): upstream's admin console is excluded as a folder; the three primitives the
 * operator Quality pages use are kept here as upstream has them.
 */

export function PageHeader({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-cream">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-warm-muted">{subtitle}</p>}
    </div>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-warm-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-forest-300 bg-forest/20 p-4", className)}>
      {children}
    </div>
  );
}
