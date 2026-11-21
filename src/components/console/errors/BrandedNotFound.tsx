import type { ReactNode } from "react";
import { SearchingBadger } from "@/components/console/badgers/honeybadgers";
import { StatusLink } from "@/components/console/errors/StatusLink";

type BrandedNotFoundProps = {
  action?: ReactNode;
  actionHref?: string;
  actionLabel?: string;
  fullScreen?: boolean;
};

export function BrandedNotFound({
  action,
  actionHref = "/organizations",
  actionLabel = "Back to organizations",
  fullScreen = false,
}: BrandedNotFoundProps) {
  return (
    <section
      className={`${fullScreen ? "min-h-dvh" : "min-h-[calc(100dvh-8rem)]"} relative isolate flex items-center justify-center overflow-hidden bg-canvas px-4 py-10 sm:px-8`}
    >
      <div
        aria-hidden
        className="absolute inset-0 opacity-35"
        style={{
          backgroundImage:
            "linear-gradient(to right, color-mix(in srgb, var(--color-forest-300) 34%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--color-forest-300) 34%, transparent) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage: "radial-gradient(ellipse 72% 66% at 50% 50%, black 22%, transparent 78%)",
        }}
      />
      <div
        aria-hidden
        className="absolute left-[12%] top-1/2 h-px w-[76%] -rotate-3 bg-gradient-to-r from-transparent via-coral/55 to-transparent shadow-[0_0_24px_var(--color-coral)]"
      />

      <div className="card-enter relative grid w-full max-w-4xl overflow-hidden rounded-2xl border border-forest-300 bg-base-deep/90 shadow-[0_32px_100px_-40px_rgba(0,0,0,0.95)] backdrop-blur-sm md:grid-cols-[1.05fr_0.95fr]">
        <div className="relative flex min-h-64 items-end justify-center overflow-hidden border-b border-forest-300 bg-forest-600/45 px-8 pt-10 md:min-h-[28rem] md:border-r md:border-b-0">
          <span
            aria-hidden
            className="absolute left-5 top-1 font-display text-[8rem] font-bold leading-none tracking-[-0.08em] text-cream/[0.035] sm:text-[11rem]"
          >
            404
          </span>
          <div
            aria-hidden
            className="absolute bottom-10 left-1/2 h-24 w-64 -translate-x-1/2 rounded-[50%] bg-coral/[0.07] blur-3xl"
          />
          <SearchingBadger className="relative z-10 h-auto w-full max-w-[21rem] text-cream-dim drop-shadow-[0_16px_38px_rgba(0,0,0,0.75)]" />
        </div>

        <div className="flex flex-col justify-center px-7 py-10 sm:px-10 md:py-12">
          <p className="eyebrow text-coral">404 // search exhausted</p>
          <h1 className="mt-3 max-w-md font-display text-3xl font-bold tracking-tight text-cream sm:text-4xl">
            Nothing surfaced here.
          </h1>
          <p className="mt-4 max-w-md text-pretty text-sm leading-6 text-warm-muted sm:text-base">
            This page was not found, or you don&apos;t have access to it. The badger checked every
            burrow.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            {action ?? <StatusLink href={actionHref}>{actionLabel}</StatusLink>}
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted/65">
              No data was changed
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
