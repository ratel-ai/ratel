import { CodeBlock } from "@ratel/design-system/code";
import { Section } from "@ratel/design-system/section";
import {
  buildQuickstartSet,
  QUICKSTART_KEY_ENV,
  QUICKSTART_LANG_LABELS,
  QUICKSTART_LANGS,
} from "@/lib/console/onboarding/quickstart";
import { APP_NAME } from "@/lib/platform/app-config";

export const DOCS_URL = "https://docs.ratel.sh";

/**
 * The SDK wiring under the key list (DESIGN.md, Show, don't explain): the
 * install line, then the snippet in each language. The same snippets the
 * Overview setup guide and onboarding hand out. No key is inlined; every
 * snippet reads it from the environment.
 */
export function SdkQuickstart({
  endpoint,
  serviceName,
}: {
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
      title="Send a trace"
      description={
        <>
          Every snippet reads the key from{" "}
          <code className="font-mono text-xs text-fg">{QUICKSTART_KEY_ENV}</code>.
        </>
      }
      actions={
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="rounded-md text-ui text-fg-muted underline decoration-line-strong underline-offset-4 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          Docs
        </a>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        {install ? (
          <CodeBlock caption="Install" samples={[{ label: "Shell", code: install }]} />
        ) : null}
        <CodeBlock caption="Send" samples={samples} />
        <p className="text-xs text-fg-subtle">
          {APP_NAME} answers <code className="font-mono">202</code> and the trace shows up in Traces
          within seconds.
        </p>
      </div>
    </Section>
  );
}
