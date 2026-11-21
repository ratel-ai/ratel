import { buttonVariants } from "@ratel/design-system/button-variants";
import { CodeBlock } from "@ratel/design-system/code";
import { DotLoader } from "@ratel/design-system/dot-matrix";
import { Section } from "@ratel/design-system/section";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  buildQuickstartSet,
  QUICKSTART_LANG_LABELS,
  QUICKSTART_LANGS,
} from "@/lib/console/onboarding/quickstart";

const DOCS_URL = "https://docs.ratel.sh";

/**
 * Before the first event, Overview is a checklist (DESIGN.md, Empty states):
 * a key, the snippet, and a live wait for the first run. The page replaces it
 * with the numbers as soon as anything arrives.
 */
export function SetupGuide({
  root,
  endpoint,
  serviceName,
}: {
  root: string;
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
        <Step number={1} title="Create an API key">
          <Link
            href={`${root}/settings/api-keys`}
            className={buttonVariants({ variant: "primary", size: "sm" })}
          >
            Create an API key
          </Link>
        </Step>
        <Step number={2} title="Add the SDK and send a run">
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
  children,
}: {
  number: number;
  title: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative flex gap-4 pb-8 last:pb-0">
      {last ? null : <span aria-hidden className="absolute top-7 bottom-1 left-3 w-px bg-line" />}
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong font-mono text-xs text-fg-muted tabular-nums">
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-3 pt-0.5 *:max-w-full">
        <p className="text-sm font-medium text-fg">{title}</p>
        {children}
      </div>
    </li>
  );
}
