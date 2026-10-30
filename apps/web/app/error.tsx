"use client";

import { BadgerMark } from "@ratel/design-system/badger-mark";
import Link from "next/link";
import { useEffect } from "react";
import { HoneybadgerImage } from "@/components/console/badgers/honeybadger-image";

type BoundaryError = Error & {
  digest?: string;
  retryable?: boolean;
  status?: number;
  statusCode?: number;
};

/**
 * App-level error boundary. Retryable server/transient failures keep reset(),
 * while explicitly permanent and non-retryable HTTP failures direct people
 * home instead of offering a button that cannot help.
 */
export default function AppError({ error, reset }: { error: BoundaryError; reset: () => void }) {
  const retryable = isRetryable(error);

  useEffect(() => {
    console.error("[app] render error:", error);
  }, [error]);

  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden bg-canvas px-6 py-12 text-center">
      <div
        aria-hidden
        className="absolute inset-0 opacity-35"
        style={{
          backgroundImage:
            "radial-gradient(circle at 50% 38%, color-mix(in srgb, var(--color-coral) 12%, transparent), transparent 28%), linear-gradient(to right, color-mix(in srgb, var(--color-forest-300) 30%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--color-forest-300) 30%, transparent) 1px, transparent 1px)",
          backgroundSize: "auto, 28px 28px, 28px 28px",
        }}
      />
      <div className="card-enter relative flex w-full max-w-xl flex-col items-center overflow-hidden rounded-2xl border border-forest-300 bg-base-deep/92 px-7 py-10 shadow-[0_32px_100px_-40px_rgba(0,0,0,0.95)] sm:px-12">
        <div className="relative flex h-24 w-64 items-end justify-center text-cream-dim">
          <div
            aria-hidden
            className="absolute bottom-0 h-14 w-44 rounded-[50%] bg-coral/[0.08] blur-2xl"
          />
          <HoneybadgerImage
            src="/badgers/tangled.png"
            alt="Tangled honey badger"
            className="relative z-10 max-h-24 w-auto drop-shadow-[0_10px_24px_rgba(0,0,0,0.7)]"
            fallback={
              <BadgerMark
                className="relative z-10 h-auto w-48"
                role="img"
                aria-label="Tangled honey badger"
                aria-hidden={undefined}
              />
            }
          />
        </div>
        <p className="mt-6 eyebrow text-coral">
          {retryable ? "Retry available" : "Route unavailable"}
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-cream">
          {retryable ? "Something slipped a burrow." : "This page can’t recover."}
        </h1>
        <p className="mt-4 max-w-md text-pretty text-sm leading-6 text-warm-muted">
          {retryable
            ? "A temporary failure interrupted this page. Try it once more, or head back to your organizations."
            : "This request failed in a way a retry won’t fix. Return to your organizations and choose another way in."}
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          {retryable && (
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-cream px-4 text-sm font-medium text-base-deep shadow-sm transition-colors hover:bg-cream-dim"
            >
              Try again
            </button>
          )}
          <Link
            href="/organizations"
            className="inline-flex h-9 items-center justify-center rounded-lg border border-forest-300 px-4 text-sm font-medium text-cream-dim transition-colors hover:bg-forest/50 hover:text-cream"
          >
            Back to organizations
          </Link>
        </div>
        {error.digest && (
          <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.08em] text-warm-muted/65">
            Reference: {error.digest}
          </p>
        )}
      </div>
    </main>
  );
}

function isRetryable(error: BoundaryError): boolean {
  if (typeof error.retryable === "boolean") return error.retryable;

  const status = error.statusCode ?? error.status;
  if (status === undefined) return true;

  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
