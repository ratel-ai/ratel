import type { Metadata } from "next";
import { StatusLink } from "@/components/console/errors/StatusLink";

export const metadata: Metadata = { title: "Maintenance" };

/** Shown in place of a workspace on hold (lib/platform/org-hold). */
export default function MaintenancePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <section className="w-full max-w-lg rounded-2xl border border-forest-300 bg-base-deep/90 px-7 py-10 sm:px-10">
        <p className="eyebrow text-coral">Maintenance</p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-cream">
          This workspace opens soon.
        </h1>
        <p className="mt-4 text-pretty text-sm leading-6 text-warm-muted sm:text-base">
          Its data is here and is being checked. Your agents can keep sending: their telemetry is
          stored.
        </p>
        <div className="mt-7">
          <StatusLink href="/organizations">Back to organizations</StatusLink>
        </div>
      </section>
    </main>
  );
}
