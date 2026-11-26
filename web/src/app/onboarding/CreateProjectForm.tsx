"use client";
import { IconButton } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { CopyButton } from "@ratel/design-system/code";
import { maskSecret } from "@ratel/design-system/mask";
import { Tabs } from "@ratel/design-system/tabs";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useEffect, useState } from "react";
import { type CreateProjectState, createProjectAction } from "@/app/onboarding/actions";
import { AgentPromptPanel } from "@/components/console/onboarding/AgentPromptPanel";
import { CaptureConsentPanel } from "@/components/console/onboarding/CaptureConsentPanel";
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
 * Shared card chrome: the plain raised surface every onboarding step sits on,
 * a hairline border and one soft shadow, nothing behind it to blur.
 *
 * `size="wide"` is for the key reveal: one column a little wider than the naming
 * step, so the prompt and the snippets read without wrapping every line.
 */
function Card({ children, size = "default" }: { children: ReactNode; size?: "default" | "wide" }) {
  return (
    <div
      className={cn(
        "card-enter w-full rounded-xl border border-line bg-raised p-6 shadow-[0_24px_60px_-32px_rgba(0,0,0,0.9)] sm:p-8",
        size === "default" && "mx-auto max-w-lg",
        size === "wide" && "mx-auto max-w-2xl",
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
          <header className="space-y-1.5">
            <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
              {name} is ready
            </h2>
            <p className="text-pretty text-sm text-fg-subtle">
              Give this prompt to your coding agent. It wires Ratel in and checks the first trace.
            </p>
          </header>

          <ApiKeyRow apiKey={apiKey} keyRevealable={keyRevealable} />

          <Tabs
            className="mt-6"
            defaultValue="agent"
            items={[
              {
                value: "agent",
                label: "Agent",
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
                label: "Human",
                content: (
                  <SdkQuickstart
                    endpoint={ingestUrl}
                    serviceName={slug}
                    maxHeight={320}
                    captureContent={capture}
                  />
                ),
              },
            ]}
          />

          {showCaptureConsent && (
            <CaptureConsentPanel
              className="mt-6 border-t border-line pt-5"
              captureContent={captureContent}
              onCaptureContentChange={setCaptureContent}
            />
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={goToDashboard}
              disabled={leaving}
              className={cn(buttonVariants({ variant: "ghost" }), "-mr-2 text-sm")}
            >
              {leaving ? "Opening dashboard…" : "Go to dashboard →"}
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
 * The secret key, one row above both tabs: the person sets it as `RATEL_API_KEY` themselves, so
 * neither the prompt nor the snippets carry it. Masked until asked, copied in one click.
 */
function ApiKeyRow({ apiKey, keyRevealable }: { apiKey: string; keyRevealable: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="mt-6">
      <div className="flex h-10 items-center gap-1 rounded-lg border border-line bg-rail pr-1.5 pl-3">
        <span className="mr-2 shrink-0 text-xs text-fg-subtle">API key</span>
        <code translate="no" className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
          {shown ? apiKey : maskSecret(apiKey)}
        </code>
        <IconButton
          label={shown ? "Hide key" : "Show key"}
          size="icon-sm"
          icon={shown ? <EyeOff /> : <Eye />}
          onClick={() => setShown((current) => !current)}
        />
        <CopyButton text={apiKey} label="Copy key" />
      </div>
      <p className="mt-2 text-xs text-fg-subtle">
        Set it as <code className="font-mono text-fg-muted">{QUICKSTART_KEY_ENV}</code> where your
        agent runs. {onboardingKeyNote(keyRevealable)}
      </p>
    </div>
  );
}
