"use client";

import { cn } from "@ratel/design-system/cn";
import { CodeBlock } from "@ratel/design-system/code";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { type CSSProperties, useMemo, useState } from "react";
import {
  buildQuickstartVariantSet,
  QUICKSTART_VARIANT_LABELS,
  QUICKSTART_VARIANTS,
  type QuickstartVariant,
} from "@/lib/console/onboarding/quickstart";

const OPTIONS = QUICKSTART_VARIANTS.map((variant) => ({
  value: variant,
  label: QUICKSTART_VARIANT_LABELS[variant],
}));

/** One line under the switch: when to pick the variant on show. */
const VARIANT_HINT: Record<QuickstartVariant, string> = {
  typescript: "Nothing in your app starts OpenTelemetry yet: start it with Ratel's processor.",
  provider:
    "Your framework already starts it (Next.js with @vercel/otel, Eve, Mastra): add Ratel's processor to it.",
  curl: "No install: one request that proves your key reaches Ratel. 202 means accepted.",
};

/**
 * The onboarding's Human tab: the wiring by hand. NodeSDK when the app owns no
 * provider, the span processor alone when the framework already starts one, and
 * curl as the zero-install key check.
 *
 * On the design system's code block and segmented control, so the snippet
 * looks like the rest of the console. The snippets themselves are built in
 * lib/console/onboarding/quickstart.ts (pure, tested); this only picks between them.
 */
export function SdkQuickstart({
  endpoint,
  serviceName,
  defaultVariant = "typescript",
  maxHeight,
  captureContent = false,
  className,
}: {
  /** Absolute OTLP traces URL for this deployment. */
  endpoint: string;
  /** Project slug, emitted as the OTel `service.name`. */
  serviceName: string;
  defaultVariant?: QuickstartVariant;
  /** Cap the snippet's height so it never pushes a CTA below the fold. */
  maxHeight?: number | string;
  /** Include the content-capture switch in the snippets that have one. */
  captureContent?: boolean;
  className?: string;
}) {
  const [variant, setVariant] = useState<QuickstartVariant>(defaultVariant);
  const snippets = useMemo(
    () => buildQuickstartVariantSet({ endpoint, serviceName, captureContent }),
    [endpoint, serviceName, captureContent],
  );
  const { install, code } = snippets[variant];
  const label = QUICKSTART_VARIANT_LABELS[variant];
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
      <SegmentedControl
        options={OPTIONS}
        value={variant}
        onValueChange={setVariant}
        label="Setup"
      />
      <p className="text-pretty text-xs leading-relaxed text-warm-muted">{VARIANT_HINT[variant]}</p>
      {/* The install line is its own copyable block: one command to paste in a
          shell, separate from the code that goes in a file. curl has none. */}
      {install && (
        <CodeBlock samples={[{ label, code: install }]} caption="Install" wrap className="w-full" />
      )}
      <div
        style={clamp}
        className={cn(
          "w-full",
          clamp && "[&_pre]:max-h-(--quickstart-max-h) [&_pre]:overflow-y-auto",
        )}
      >
        <CodeBlock samples={[{ label, code }]} caption={variant === "curl" ? "Shell" : "Code"} />
      </div>
    </div>
  );
}
