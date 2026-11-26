import { buttonVariants } from "@ratel/design-system/button-variants";
import { CodeBlock } from "@ratel/design-system/code";
import { DotLoader } from "@ratel/design-system/dot-matrix";
import { Section } from "@ratel/design-system/section";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { ApiKeyCta } from "@/components/console/settings/ApiKeyCta";
import type { ApiKeyCta as ApiKeyCtaModel } from "@/lib/console/api-key-cta";
import {
  buildQuickstartSet,
  QUICKSTART_LANG_LABELS,
  QUICKSTART_LANGS,
} from "@/lib/console/onboarding/quickstart";

const DOCS_URL = "https://docs.ratel.sh";

/**
 * Before the first event, Overview is a checklist (DESIGN.md, Empty states):
 * a key, the snippet, and a live wait for the first run. The page replaces it
 * with the numbers as soon as anything arrives. A project that already has a
 * usable key (onboarding issues one) is shown that key, not asked for another,
 * and its next step is sending the first trace.
 */
export function SetupGuide({
  apiKey,
  endpoint,
  serviceName,
}: {
  /** The project's API-key CTA (`loadApiKeyCta`). */
  apiKey: ApiKeyCtaModel;
  /** Absolute OTLP traces URL for this deployment. */
  endpoint: string;
  /** Project slug, sent as the OpenTelemetry `service.name`. */
  serviceName: string;
}) {
  const snippets = buildQuickstartSet({ endpoint, serviceName });
  const install = snippets.typescript.install;
  const samples = QUICKSTART_LANGS.map((lang) => ({
    label: QUICKSTART_LANG_LABELS[lang],
    code: snippets[lang].code,
  }));

  return (
    <Section
      className="max-w-3xl"
      title="Send your first run"
      description="Connect your agent and this page fills in with runs, problems and spend."
      actions={
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-ui text-fg-muted underline decoration-line-strong underline-offset-4 hover:text-fg"
        >
          Docs
        </a>
      }
    >
      <ol className="flex flex-col">
        {apiKey.kind === "view" ? (
          <Step number={1} title="Your API key is ready" done>
            <ApiKeyCta
              cta={apiKey}
              detail
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            />
          </Step>
        ) : (
          <Step number={1} title="Create an API key">
            <ApiKeyCta
              cta={apiKey}
              className={buttonVariants({ variant: "primary", size: "sm" })}
            />
          </Step>
        )}
        <Step
          number={2}
          title={
            apiKey.kind === "view"
              ? "Next: add the SDK and send your first trace"
              : "Add the SDK and send a run"
          }
        >
          <div className="flex w-full flex-col gap-3">
            {install ? (
              <CodeBlock caption="Install" samples={[{ label: "Shell", code: install }]} />
            ) : null}
            <CodeBlock samples={samples} />
          </div>
        </Step>
        <Step number={3} title="Watch it arrive" last>
          <div className="flex items-center gap-3 text-ui text-fg-muted">
            <DotLoader label="Waiting for your first event" size="sm" />
            {/* The loader already announces this; the words are for sighted readers. */}
            <span aria-hidden>Waiting for your first event…</span>
          </div>
        </Step>
      </ol>
    </Section>
  );
}

function Step({
  number,
  title,
  last = false,
  done = false,
  children,
}: {
  number: number;
  title: string;
  last?: boolean;
  /** Already true for this project: the number reads as a check. */
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative flex gap-4 pb-8 last:pb-0">
      {last ? null : <span aria-hidden className="absolute top-7 bottom-1 left-3 w-px bg-line" />}
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong font-mono text-xs text-fg-muted tabular-nums">
        {done ? <Check className="size-3.5" aria-label={`Step ${number} done`} /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-3 pt-0.5 *:max-w-full">
        <p className="text-sm font-medium text-fg">{title}</p>
        {children}
      </div>
    </li>
  );
}
