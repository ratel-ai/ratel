"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { CopyButton } from "@ratel/design-system/code";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { changeSlackAppAction } from "@/app/(console)/org/[orgSlug]/settings/slack/actions";
import { CANNOT_STORE } from "@/lib/views/slack/types";

/** Organization settings > Slack: the app the organization's projects install. */
export function SlackAppSettings({
  orgSlug,
  clientId: savedId,
  redirectUrl,
  manifestUrl,
  canStore,
}: {
  orgSlug: string;
  /** Null: none saved. */
  clientId: string | null;
  redirectUrl: string;
  /** Slack's create-app page with everything filled in. */
  manifestUrl: string;
  /** Whether this deployment can keep the secret. */
  canStore: boolean;
}) {
  const router = useRouter();
  const [clientId, setClientId] = useState(savedId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [removing, setRemoving] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    startSave(async () => {
      const result = await changeSlackAppAction({
        orgSlug,
        action: "save",
        clientId,
        clientSecret,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({ title: "Slack app saved", tone: "success" });
      setClientSecret("");
      router.refresh();
    });
  }

  async function remove() {
    const result = await changeSlackAppAction({ orgSlug, action: "remove" });
    if (!result.ok) {
      toast({ title: result.error, tone: "danger" });
      return;
    }
    toast({ title: "Removed the Slack app" });
    setClientId("");
    router.refresh();
  }

  return (
    <PageBody className="*:min-w-0">
      <Section
        title="1. Create the app"
        description="Slack opens with the name, the permissions and the redirect URL filled in."
      >
        <div className="flex max-w-xl flex-col gap-4">
          <a
            href={manifestUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ className: "self-start" })}
          >
            Create the app in Slack
          </a>
          <Field label="Redirect URL" description="For an app that exists already.">
            {(control) => (
              <span className="flex items-center gap-2">
                <Input {...control} readOnly value={redirectUrl} className="font-mono text-xs" />
                <CopyButton text={redirectUrl} label="Copy the redirect URL" />
              </span>
            )}
          </Field>
          {redirectUrl.startsWith("https://") ? null : (
            <Callout tone="warning" title="Slack needs an https address">
              Set APP_PUBLIC_URL or BASE_URL to this deployment's https address and restart it.
            </Callout>
          )}
        </div>
      </Section>
      <Section
        title="2. Save its credentials"
        description="In Slack, under Basic Information, App Credentials."
      >
        {canStore ? (
          <form noValidate onSubmit={submit} className="flex max-w-xl flex-col gap-4">
            <Field label="Client ID">
              {(control) => (
                <Input
                  {...control}
                  value={clientId}
                  placeholder="1234567890.1234567890"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setClientId(event.currentTarget.value)}
                />
              )}
            </Field>
            <Field
              label="Client Secret"
              description={savedId ? "Saved. Enter it again to change the app." : undefined}
            >
              {(control) => (
                // A secret: shown as dots, and never again after it is saved.
                <Input
                  {...control}
                  type="password"
                  value={clientSecret}
                  placeholder={savedId ? "••••••••••••••••" : undefined}
                  autoComplete="new-password"
                  spellCheck={false}
                  onChange={(event) => setClientSecret(event.currentTarget.value)}
                />
              )}
            </Field>
            {error ? (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            ) : null}
            <span className="flex items-center gap-2">
              <Button type="submit" variant="primary" loading={saving}>
                Save app
              </Button>
              {savedId ? (
                <Button className="text-danger" onClick={() => setRemoving(true)}>
                  Remove…
                </Button>
              ) : null}
            </span>
          </form>
        ) : (
          <Callout tone="warning" title="The app cannot be saved">
            {CANNOT_STORE}
          </Callout>
        )}
      </Section>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove the Slack app?"
        description="A connected workspace stays connected. Nobody can connect another one."
        confirmLabel="Remove app"
        onConfirm={remove}
      />
    </PageBody>
  );
}
