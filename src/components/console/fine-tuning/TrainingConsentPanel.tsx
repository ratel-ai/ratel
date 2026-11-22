"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ConsentView } from "@/lib/views/fine-tuning/domain/consent";

/**
 * The training opt-in of a project (RC-1123). Everyone sees the terms and
 * whether the opt-in is on; an organization admin gives or withdraws it. Each
 * change is one call to the consent route; the page re-reads after it.
 */
export function TrainingConsentPanel({
  apiHref,
  consent,
  text,
  canEdit,
}: {
  apiHref: string;
  consent: ConsentView;
  text: { version: string; title: string; terms: readonly string[] };
  canEdit: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function change(method: "POST" | "DELETE") {
    setError(null);
    startTransition(async () => {
      const response = await fetch(apiHref, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({ textVersion: text.version }) : undefined,
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
      } | null;
      if (!response.ok || !result?.ok) {
        setError(result?.message ?? "The change was not saved. Try again.");
        return;
      }
      router.refresh();
    });
  }

  const action = canEdit ? (
    consent.active ? (
      <Button variant="secondary" loading={pending} onClick={() => change("DELETE")}>
        Withdraw opt-in
      </Button>
    ) : (
      <Button variant="primary" loading={pending} onClick={() => change("POST")}>
        Give opt-in
      </Button>
    )
  ) : null;

  return (
    <Section
      title="Training opt-in"
      description={text.title}
      actions={
        <>
          <Badge tone={consent.active ? "success" : "neutral"}>
            {consent.active ? "On" : "Off"}
          </Badge>
          {action}
        </>
      }
    >
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-fg-muted">
        {text.terms.map((term) => (
          <li key={term}>{term}</li>
        ))}
      </ul>
      {consent.active && consent.givenAt ? (
        <p className="text-ui text-fg-subtle">
          Given on {new Date(consent.givenAt).toLocaleDateString()} (text version{" "}
          {consent.textVersion}).
        </p>
      ) : null}
      {!canEdit ? (
        <p className="text-ui text-fg-subtle">Only organization admins can change the opt-in.</p>
      ) : null}
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Section>
  );
}
