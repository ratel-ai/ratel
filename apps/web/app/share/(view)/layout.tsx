import { BadgerMark } from "@ratel/design-system/badger-mark";
import type { ReactNode } from "react";

/**
 * The public frame for shared Agent health pages: no sidebar, no session, no
 * project switcher. Everything under `/share` is read-only and gates on its own
 * token; nothing here is inherited from the signed-in app.
 */
export default function ShareLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-forest-300/70 bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <a
            href="https://ratel.sh"
            className="flex items-center gap-2.5 text-cream"
            aria-label="Ratel"
          >
            <BadgerMark className="h-5 w-auto" />
            <span className="text-sm font-semibold tracking-tight">
              Ratel <span className="text-warm-muted">Cloud</span>
            </span>
          </a>
          <span className="rounded-full border border-forest-300 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted">
            Read-only view
          </span>
        </div>
      </header>
      <main className="flex-1 px-4 py-8 sm:px-6 sm:py-10">{children}</main>
      <footer className="border-t border-forest-300/70">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs text-warm-muted sm:px-6">
          <span>Agent health reads an agent&apos;s own traces and names what to fix.</span>
          <a href="https://ratel.sh" className="text-cream-dim transition-colors hover:text-cream">
            Get this for your agent at ratel.sh
          </a>
        </div>
      </footer>
    </div>
  );
}
