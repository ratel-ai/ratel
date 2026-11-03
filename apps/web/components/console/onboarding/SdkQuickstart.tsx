"use client";

import { cn } from "@ratel/design-system/cn";
import { CodeBlock } from "@ratel/design-system/code";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { type CSSProperties, useMemo, useState } from "react";
import {
  buildQuickstartSet,
  QUICKSTART_LANG_LABELS,
  QUICKSTART_LANGS,
  type QuickstartLang,
} from "@/lib/console/onboarding/quickstart";

const OPTIONS = QUICKSTART_LANGS.map((lang) => ({
  value: lang,
  label: QUICKSTART_LANG_LABELS[lang],
}));

/**
 * "Send your first trace": the OpenTelemetry wiring for TypeScript, with curl
 * as the zero-install fallback.
 *
 * Upstream's component sits on its own code block and segmented control; this
 * one is the same shape on the design system's, so the snippet a reader meets
 * here looks like the rest of the console. The snippets themselves are built in
 * lib/console/onboarding/quickstart.ts (pure, tested); this only picks between them.
 */
export function SdkQuickstart({
  endpoint,
  serviceName,
  defaultLang = "typescript",
  maxHeight,
  captureContent = false,
  className,
}: {
  /** Absolute OTLP traces URL for this deployment. */
  endpoint: string;
  /** Project slug, emitted as the OTel `service.name`. */
  serviceName: string;
  defaultLang?: QuickstartLang;
  /** Cap the snippet's height so it never pushes a CTA below the fold. */
  maxHeight?: number | string;
  /** Include the content-capture switch in the TypeScript snippet. */
  captureContent?: boolean;
  className?: string;
}) {
  const [lang, setLang] = useState<QuickstartLang>(defaultLang);
  const snippets = useMemo(
    () => buildQuickstartSet({ endpoint, serviceName, captureContent }),
    [endpoint, serviceName, captureContent],
  );
  const { install, code } = snippets[lang];
  const label = QUICKSTART_LANG_LABELS[lang];
  // CodeBlock has no height cap of its own: the wrapper clamps its <pre> through
  // a variable, so the bar with the copy button stays put while a long snippet
  // scrolls.
  const clamp =
    maxHeight === undefined
      ? undefined
      : ({
          "--quickstart-max-h": typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight,
        } as CSSProperties);

  return (
    // items-start keeps the pill at its natural width; the code blocks below
    // carry w-full.
    <div className={cn("flex flex-col items-start gap-3", className)}>
      <SegmentedControl options={OPTIONS} value={lang} onValueChange={setLang} label="Language" />
      {/* The install line is its own copyable block: one command to paste in a
          shell, separate from the code that goes in a file. curl has none. */}
      {install && <CodeBlock samples={[{ label, code: install }]} wrap className="w-full" />}
      <div
        style={clamp}
        className={cn(
          "w-full",
          clamp && "[&_pre]:max-h-(--quickstart-max-h) [&_pre]:overflow-y-auto",
        )}
      >
        <CodeBlock samples={[{ label, code }]} wrap />
      </div>
    </div>
  );
}
