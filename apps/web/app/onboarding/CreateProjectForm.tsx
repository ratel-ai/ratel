"use client";
import { cn } from "@ratel/design-system/cn";
import { useCopyToClipboard } from "@ratel/design-system/use-copy-to-clipboard";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useEffect, useState } from "react";
import { type CreateProjectState, createProjectAction } from "@/app/onboarding/actions";
import { CaptureConsentPanel } from "@/components/console/onboarding/CaptureConsentPanel";
import { OnboardingEmblem } from "@/components/console/onboarding/OnboardingEmblem";
import { SdkQuickstart } from "@/components/console/onboarding/SdkQuickstart";
import { NAV_DELAY_MS, ONBOARDING_LEAVE_EVENT } from "@/lib/console/onboarding/transition";
import { APP_NAME } from "@/lib/platform/app-config";

/**
 * Shared card chrome: the frosted instrument panel every onboarding step sits in.
 *
 * The surface is deliberately thin (a low-alpha wash over a heavy blur) so the
 * dot-field behind it stays legible through the panel instead of being
 * boxed out — the blur, the hairline border, and the drop shadow do the
 * separating.
 *
 * `size="wide"` is for the key reveal, which carries the API key *and* the
 * quickstart: at the naming step's width that content ran past the fold and the
 * "Go to dashboard" button needed a scroll to reach.
 */
function Card({ children, size = "default" }: { children: ReactNode; size?: "default" | "wide" }) {
  return (
    <div
      className={cn(
        "card-enter w-full rounded-2xl border border-forest-300/70 bg-forest-600/30 p-6 shadow-[0_24px_70px_-30px_rgba(0,0,0,0.85)] backdrop-blur-2xl sm:p-8",
        size === "default" && "mx-auto max-w-lg",
      )}
    >
      {children}
    </div>
  );
}

export function CreateProjectForm({
  ingestUrl,
  keyIssuedCameo,
  organization,
}: {
  ingestUrl: string;
  /** Rendered by the server because optional badger assets are resolved from disk. */
  keyIssuedCameo?: ReactNode;
  organization?: {
    id: string;
    name: string;
    slug: string;
    isFirstProject: boolean;
  };
}) {
  const [state, action, pending] = useActionState<CreateProjectState, FormData>(
    createProjectAction,
    null,
  );

  if (state?.ok) {
    return (
      <KeyReveal
        id={state.id}
        name={state.name}
        slug={state.slug}
        apiKey={state.apiKey}
        ingestUrl={ingestUrl}
        cameo={keyIssuedCameo}
        showCaptureConsent={state.showCaptureConsent}
      />
    );
  }

  return (
    <Card>
      {organization && (
        <Link
          href={`/org/${encodeURIComponent(organization.slug)}`}
          className="mb-6 inline-flex items-center gap-1.5 font-mono text-xs text-warm-muted transition-colors hover:text-cream"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Cancel
        </Link>
      )}
      <header className="flex flex-col items-center gap-4 text-center">
        <OnboardingEmblem />
        <div className="eyebrow flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-coral" aria-hidden />
          {organization ? organization.name : `${APP_NAME}`}
        </div>
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-bold tracking-tight text-cream">
            {organization && !organization.isFirstProject
              ? "New project"
              : "Set up your first project"}
          </h1>
          <p className="mx-auto max-w-sm text-pretty text-sm text-warm-muted">
            {organization && !organization.isFirstProject
              ? `Create another agent in ${organization.name}. We'll issue an API key and show you how to start sending context data.`
              : "Name your agent. We'll issue an API key and show you how to start sending context data."}
          </p>
        </div>
      </header>

      <form action={action} className="mt-7 flex w-full flex-col gap-3">
        {organization && <input type="hidden" name="organizationId" value={organization.id} />}
        <label
          htmlFor="name"
          className="text-left font-mono text-xs uppercase tracking-wide text-warm-muted"
        >
          Agent name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          // biome-ignore lint/a11y/noAutofocus: the one field on a first-run screen, as upstream has it
          autoFocus
          placeholder="support-copilot"
          maxLength={60}
          className="rounded-lg border border-forest-300 bg-base-deep/60 px-4 py-2.5 font-mono text-cream placeholder:text-warm-muted/60 focus:border-coral focus:outline-none"
        />
        {state && !state.ok && (
          <p className="text-left font-mono text-sm text-coral">{state.error}</p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="mt-1 rounded-lg bg-cream px-5 py-2.5 text-sm font-medium text-base-deep shadow-sm transition-colors hover:bg-cream-dim disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create project & get API key"}
        </button>
      </form>
    </Card>
  );
}

function KeyReveal({
  id,
  name,
  slug,
  apiKey,
  ingestUrl,
  cameo,
  showCaptureConsent,
}: {
  id: string;
  name: string;
  slug: string;
  apiKey: string;
  ingestUrl: string;
  cameo?: ReactNode;
  showCaptureConsent: boolean;
}) {
  const router = useRouter();
  const { copyStatus, copyToClipboard } = useCopyToClipboard();
  const [leaving, setLeaving] = useState(false);
  const [captureContent, setCaptureContent] = useState(false);

  const dashboardHref = `/project/${id}`;

  // Warm the dashboard route so the handoff after the exit animation is instant.
  useEffect(() => {
    router.prefetch(dashboardHref);
  }, [router, dashboardHref]);

  // Drain the streaks, settle + dissolve, then navigate — landing on the
  // dashboard's own pop-in. Reduced-motion users go straight there, no animation.
  function goToDashboard() {
    if (leaving) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      router.push(dashboardHref);
      return;
    }
    // Tell the background we are leaving (upstream's streak field drains on it;
    // this edition's static backdrop has nothing to wind down).
    window.dispatchEvent(new CustomEvent(ONBOARDING_LEAVE_EVENT));
    setLeaving(true);
    window.setTimeout(() => router.push(dashboardHref), NAV_DELAY_MS);
  }

  return (
    <>
      <div className={leaving ? "onboarding-settle" : undefined}>
        <Card size="wide">
          {/* Laid out side-by-side from `sm` up: the cameo next to the headline
          instead of above it keeps the panel short enough that the key, the
          quickstart, and the dashboard button all sit above the fold. */}
          <header className="flex flex-col items-center gap-4 text-center sm:flex-row sm:gap-6 sm:text-left">
            <div className="relative flex h-24 w-36 shrink-0 items-center justify-center">
              <div
                className="absolute inset-x-5 bottom-1 h-8 rounded-[50%] bg-coral/[0.08] blur-2xl"
                aria-hidden
              />
              {cameo ?? <OnboardingEmblem tone="mint" />}
            </div>
            <div className="min-w-0 space-y-2">
              <h2 className="font-display text-2xl font-bold tracking-tight text-cream">
                <span className="text-coral">{name}</span> is ready
              </h2>
              <p className="text-pretty text-sm text-warm-muted">
                Treat this API key like a password. Copy it now; it is not shown again.
              </p>
            </div>
          </header>

          {showCaptureConsent && (
            <div className="mt-6">
              <CaptureConsentPanel
                captureContent={captureContent}
                onCaptureContentChange={setCaptureContent}
              />
            </div>
          )}

          <div className="mt-6 flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <div className="font-mono text-xs uppercase tracking-wide text-warm-muted">
                Secret API key
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-coral/40 bg-coral/10 p-3">
                <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-cream">
                  {apiKey}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(apiKey)}
                  className="shrink-0 rounded-md bg-cream px-3 py-1.5 font-mono text-xs font-medium text-base-deep transition-colors hover:bg-cream-dim"
                >
                  <span aria-live="polite">
                    {copyStatus === "copied"
                      ? "Copied"
                      : copyStatus === "failed"
                        ? "Copy failed"
                        : "Copy"}
                  </span>
                </button>
              </div>
              <p className="font-mono text-[11px] leading-relaxed text-warm-muted">
                Export this key as <code>RATEL_API_KEY</code> — the SDK reads it from the
                environment so it never lands in your source.
              </p>
            </div>

            <div className="space-y-2">
              <div className="font-mono text-xs uppercase tracking-wide text-warm-muted">
                Send your first trace
              </div>
              <SdkQuickstart
                endpoint={ingestUrl}
                serviceName={slug}
                maxHeight={180}
                captureContent={showCaptureConsent && captureContent}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={goToDashboard}
            disabled={leaving}
            className="mt-6 flex w-full items-center justify-center rounded-lg bg-cream px-5 py-2.5 text-sm font-medium text-base-deep shadow-sm transition-colors hover:bg-cream-dim disabled:cursor-default"
          >
            {leaving ? "Opening dashboard…" : `Go to ${slug} dashboard →`}
          </button>
        </Card>
      </div>

      {/* Base-coloured veil that dissolves the whole first-run scene into the
        canvas as we leave. Held OUTSIDE the settling wrapper: nested inside it,
        this veil's fade-IN would be cancelled by the panel's own fade-OUT (a
        fixed child still inherits an ancestor's opacity), so the scene never
        actually dissolved. Out here it fades to base over the dot-field, then
        navigation reveals the dashboard behind. */}
      {leaving && <div className="onboarding-dissolve fixed inset-0 z-50 bg-canvas" aria-hidden />}
    </>
  );
}
