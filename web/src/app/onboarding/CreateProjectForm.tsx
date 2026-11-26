"use client";
import { cn } from "@ratel/design-system/cn";
import { maskSecret } from "@ratel/design-system/mask";
import { Tabs } from "@ratel/design-system/tabs";
import { useCopyToClipboard } from "@ratel/design-system/use-copy-to-clipboard";
import { ArrowLeft, Bot, Eye, EyeOff, KeyRound, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useEffect, useState } from "react";
import { type CreateProjectState, createProjectAction } from "@/app/onboarding/actions";
import { AgentPromptPanel } from "@/components/console/onboarding/AgentPromptPanel";
import { CaptureConsentPanel } from "@/components/console/onboarding/CaptureConsentPanel";
import { HandoffArt } from "@/components/console/onboarding/HandoffArt";
import { OnboardingEmblem } from "@/components/console/onboarding/OnboardingEmblem";
import { SdkQuickstart } from "@/components/console/onboarding/SdkQuickstart";
import { navigateUnderVeil } from "@/lib/console/onboarding/arrival-veil";
import { onboardingKeyNote } from "@/lib/console/onboarding/key-note";
import { QUICKSTART_KEY_ENV } from "@/lib/console/onboarding/quickstart";
import {
  LEAVE_VEIL_DELAY_MS,
  LEAVE_VEIL_MS,
  NAV_DELAY_MS,
  ONBOARDING_LEAVE_EVENT,
} from "@/lib/console/onboarding/transition";
import { APP_NAME, BASE_URL } from "@/lib/platform/app-config";

/**
 * Shared card chrome: the frosted instrument panel every onboarding step sits in.
 *
 * The surface is deliberately thin (a low-alpha wash over a heavy blur) so the
 * backdrop's light stays legible through the panel instead of being
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
  emblem,
  organization,
}: {
  ingestUrl: string;
  /** The badge heading the naming step: the edition's (`EditionUi.OnboardingArt`), else the mark. */
  emblem?: ReactNode;
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
        keyRevealable={state.keyRevealable}
        ingestUrl={ingestUrl}
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
        {emblem ?? <OnboardingEmblem />}
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
  keyRevealable,
  ingestUrl,
  showCaptureConsent,
}: {
  id: string;
  name: string;
  slug: string;
  apiKey: string;
  keyRevealable: boolean;
  ingestUrl: string;
  showCaptureConsent: boolean;
}) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [captureContent, setCaptureContent] = useState(false);
  const capture = showCaptureConsent && captureContent;

  const dashboardHref = `/project/${id}`;
  // Where the prompt tells the agent the first trace shows up.
  const tracesUrl = `${BASE_URL}/project/${encodeURIComponent(id)}/traces`;

  // Warm the dashboard route so the handoff after the exit animation is instant.
  useEffect(() => {
    router.prefetch(dashboardHref);
  }, [router, dashboardHref]);

  // Settle + dissolve, then navigate, and the dashboard fades in. Reduced-motion
  // users go straight there, no animation.
  function goToDashboard() {
    if (leaving) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      router.push(dashboardHref);
      return;
    }
    // Still announced, for anything on the page that winds down on the way out.
    window.dispatchEvent(new CustomEvent(ONBOARDING_LEAVE_EVENT));
    setLeaving(true);
    // Under a veil that outlives this page, so the dashboard fades in.
    window.setTimeout(
      () => navigateUnderVeil(dashboardHref, (href) => router.push(href)),
      NAV_DELAY_MS,
    );
  }

  return (
    <>
      <div className={leaving ? "onboarding-settle" : undefined}>
        <Card size="wide">
          <header className="flex flex-col items-center gap-5 text-center sm:flex-row sm:gap-7 sm:text-left">
            <HandoffArt className="shrink-0" />
            <div className="min-w-0 space-y-2">
              <h2 className="font-display text-2xl font-bold tracking-tight text-cream">
                <span className="text-coral">{name}</span> is ready
              </h2>
              <p className="max-w-xl text-pretty text-sm text-warm-muted">
                Hand the setup to your coding agent: one prompt wires Ratel into your app and checks
                that the first trace arrives.
              </p>
            </div>
          </header>

          <ApiKeyStrip apiKey={apiKey} keyRevealable={keyRevealable} />

          {/* The prompt (or the snippets) beside what they will send: the two columns are
          the same height, so neither holds a lone field next to a long one. */}
          <div
            className={cn(
              "mt-6 grid items-start gap-6",
              showCaptureConsent && "lg:grid-cols-[minmax(0,1fr)_19rem]",
            )}
          >
            <Tabs
              defaultValue="agent"
              items={[
                {
                  value: "agent",
                  label: (
                    <>
                      <Bot aria-hidden />
                      Agent
                    </>
                  ),
                  content: (
                    <AgentPromptPanel
                      projectName={name}
                      serviceName={slug}
                      endpoint={ingestUrl}
                      tracesUrl={tracesUrl}
                      captureContent={capture}
                    />
                  ),
                },
                {
                  value: "human",
                  label: (
                    <>
                      <UserRound aria-hidden />
                      Human
                    </>
                  ),
                  content: (
                    <SdkQuickstart
                      endpoint={ingestUrl}
                      serviceName={slug}
                      maxHeight={400}
                      captureContent={capture}
                    />
                  ),
                },
              ]}
            />

            {showCaptureConsent && (
              <CaptureConsentPanel
                captureContent={captureContent}
                onCaptureContentChange={setCaptureContent}
              />
            )}
          </div>

          <div className="mt-6 flex flex-col-reverse items-center gap-3 border-t border-forest-300/60 pt-5 sm:flex-row sm:justify-between">
            <p className="text-center text-xs text-warm-muted sm:text-left">
              The snippets stay in Settings › API keys.
            </p>
            <button
              type="button"
              onClick={goToDashboard}
              disabled={leaving}
              className="w-full rounded-lg border border-forest-300 bg-forest-600/60 px-4 py-2 text-sm font-medium text-cream transition-colors duration-120 hover:bg-forest disabled:cursor-default sm:w-auto"
            >
              {leaving ? "Opening dashboard…" : `Go to ${slug} dashboard →`}
            </button>
          </div>
        </Card>
      </div>

      {/* Base-coloured veil that dissolves the whole first-run scene into the
        canvas as we leave. Held OUTSIDE the settling wrapper: nested inside it,
        this veil's fade-IN would be cancelled by the panel's own fade-OUT (a
        fixed child still inherits an ancestor's opacity), so the scene never
        actually dissolved. Out here it fades to base over the backdrop, then
        navigation reveals the dashboard behind. */}
      {leaving && (
        <div
          className="onboarding-dissolve fixed inset-0 z-50 bg-canvas"
          style={{
            animationDelay: `${LEAVE_VEIL_DELAY_MS}ms`,
            animationDuration: `${LEAVE_VEIL_MS}ms`,
          }}
          aria-hidden
        />
      )}
    </>
  );
}

/**
 * The secret key, full width above both tabs: the person sets it as `RATEL_API_KEY` themselves,
 * so neither the prompt nor the snippets carry it. Masked until asked, copied in one click.
 */
function ApiKeyStrip({ apiKey, keyRevealable }: { apiKey: string; keyRevealable: boolean }) {
  const { copyStatus, copyToClipboard } = useCopyToClipboard();
  const [shown, setShown] = useState(false);
  return (
    <div className="mt-6">
      <div className="flex flex-col gap-2 rounded-lg border border-forest-300/70 bg-base-deep/50 p-2 pl-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex shrink-0 items-center gap-2">
          <KeyRound className="size-4 text-coral" strokeWidth={1.5} aria-hidden />
          <span className="text-sm font-medium text-cream">Secret API key</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-coral/40 bg-coral/10 py-1 pr-1 pl-3">
          <span className="sr-only">API key: </span>
          <code translate="no" className="min-w-0 flex-1 truncate font-mono text-sm text-cream">
            {shown ? apiKey : maskSecret(apiKey)}
          </code>
          <button
            type="button"
            onClick={() => setShown((current) => !current)}
            aria-label={shown ? "Hide key" : "Show key"}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-cream-dim transition-colors hover:bg-forest hover:text-cream"
          >
            {shown ? (
              <EyeOff className="size-3.5" aria-hidden />
            ) : (
              <Eye className="size-3.5" aria-hidden />
            )}
          </button>
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
      </div>
      <p className="mt-2 text-pretty text-xs leading-relaxed text-warm-muted">
        Set it as <code className="font-mono text-cream-dim">{QUICKSTART_KEY_ENV}</code> where your
        agent runs. The prompt and the snippets read it from there, so the key never goes into your
        agent&apos;s chat. {onboardingKeyNote(keyRevealable)}
      </p>
    </div>
  );
}
