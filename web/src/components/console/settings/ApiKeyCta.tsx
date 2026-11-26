import { KeyRound, Send } from "lucide-react";
import Link from "next/link";
import type { ApiKeyCta as ApiKeyCtaModel } from "@/lib/console/api-key-cta";

/**
 * The API-key call to action, drawn the same way wherever a page has nothing
 * sent yet (the Overview's setup guide, the Traces empty state, Agent health's
 * states). The page decides `cta` on the server (`loadApiKeyCta`); this only
 * draws it, so it renders in server and client components alike.
 *
 * - `step="key"`: the key link. "Create an API key" without a usable key,
 *   "View API keys" with one; `detail` names that key (name, prefix, created).
 * - `step="next"`: what to do next. Creating the key, or, once there is one,
 *   sending the first trace (the docs).
 *
 * `className` is the button look of the surface it sits in.
 */
export function ApiKeyCta({
  cta,
  step = "key",
  className,
  icon = false,
  detail = false,
}: {
  cta: ApiKeyCtaModel;
  step?: "key" | "next";
  className?: string;
  /** Lead with an icon, as the health states' buttons do. */
  icon?: boolean;
  /** With a key, say which one beside the link. */
  detail?: boolean;
}) {
  const data = { "data-api-key-cta": cta.kind, "data-api-key-step": step };
  if (step === "next" && cta.kind === "view") {
    return (
      <a href={cta.next.href} target="_blank" rel="noreferrer" className={className} {...data}>
        {icon && <Send strokeWidth={1.5} aria-hidden />}
        {cta.next.label}
      </a>
    );
  }
  const link = (
    <Link href={cta.href} className={className} {...data}>
      {icon && <KeyRound strokeWidth={1.5} aria-hidden />}
      {cta.label}
    </Link>
  );
  if (!detail || !cta.key) return link;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {link}
      <span className="font-mono text-xs text-fg-muted" data-api-key-detail>
        {cta.key.detail}
      </span>
    </div>
  );
}
