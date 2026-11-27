"use client";

import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Field, Input } from "@ratel/design-system/input";
import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { changeDestinationAction } from "@/app/(console)/project/[projectId]/alerts/actions";
import { type AlertDestination, MAX_DESTINATION_NAME } from "@/lib/views/alerts/types";
import { slackErrorText } from "@/lib/views/slack/errors";
import { SlackConnectionPanel, type SlackState } from "../slack/SlackConnectionPanel";

const HOW_TO = "https://api.slack.com/messaging/webhooks";

/** Settings > Notifications: the organization's Slack, and where the project's alerts go. */
export function SlackDestinations({
  projectId,
  destinations,
  canStore,
  slack,
  notice,
}: {
  projectId: string;
  destinations: readonly AlertDestination[];
  /** Whether this deployment can keep a secret. */
  canStore: boolean;
  slack: SlackState;
  /** How an install just ended. */
  notice: { ok: boolean; text: string } | null;
}) {
  const [removing, setRemoving] = useState<AlertDestination | null>(null);
  const [open, setOpen] = useState(false);
  const router = useRouter();

  async function remove() {
    if (!removing) return;
    const result = await changeDestinationAction({
      projectId,
      action: "remove",
      destinationId: removing.id,
    });
    if (!result.ok) toast({ title: result.error, tone: "danger" });
    else toast({ title: `Removed ${removing.name}` });
    router.refresh();
  }

  // The address keeps the notice: a channel picked since, or a connection lost since, ends it.
  const done = destinations.some(({ kind }) => kind === "slack_channel") || slack.connection?.lost;

  const columns: Column<AlertDestination>[] = [
    {
      id: "name",
      header: "Name",
      className: "w-full",
      cell: (row) => (
        <span className="flex flex-col gap-0.5 py-1">
          {row.name}
          {row.kind === "slack_channel" && row.accessError ? (
            <span className="text-xs text-danger">{slackErrorText(row.accessError)}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "way",
      header: "Sent by",
      width: "14rem",
      hiddenBelow: "sm",
      cell: (row) =>
        row.kind === "webhook" ? (
          <span className="font-mono text-xs whitespace-nowrap text-fg-muted">
            {`hooks.slack.com/…${row.lastFour}`}
          </span>
        ) : (
          <span className="whitespace-nowrap text-fg-muted">Slack app</span>
        ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      width: "16rem",
      align: "right",
      cell: (row) => (
        <span className="inline-flex items-center gap-2">
          <TestButton projectId={projectId} destination={row} />
          <Button
            size="sm"
            className="text-danger"
            onClick={() => {
              setRemoving(row);
              setOpen(true);
            }}
          >
            Remove…
          </Button>
        </span>
      ),
    },
  ];

  return (
    <PageBody className="*:min-w-0">
      {notice && !(notice.ok && done) ? (
        <Callout
          tone={notice.ok ? "info" : "danger"}
          title={notice.ok ? notice.text : "Slack was not connected"}
        >
          {notice.ok ? "Pick a channel next." : notice.text}
        </Callout>
      ) : null}
      <SlackConnectionPanel projectId={projectId} canStore={canStore} slack={slack} />
      <Section title="Destinations" description="Where your alerts can go.">
        {destinations.length > 0 ? (
          <DataTable
            caption="Destinations"
            columns={columns}
            rows={destinations}
            rowKey={(row) => row.id}
          />
        ) : (
          <p className="text-ui text-fg-muted">No destination yet.</p>
        )}
      </Section>
      {canStore ? (
        <Disclosure title="Other ways to connect" hint="Webhook URL">
          <AddWebhook projectId={projectId} />
        </Disclosure>
      ) : null}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Remove ${removing?.name ?? ""}?`}
        description="Alerts that use it stop sending there."
        confirmLabel="Remove destination"
        onConfirm={remove}
      />
    </PageBody>
  );
}

function AddWebhook({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    startSave(async () => {
      const result = await changeDestinationAction({ projectId, action: "add", name, url });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({ title: `Added ${name.trim()}`, tone: "success" });
      setName("");
      setUrl("");
      router.refresh();
    });
  }

  return (
    <Section title="Webhook URL">
      <form noValidate onSubmit={submit} className="flex max-w-xl flex-col gap-4">
        <Field label="Name" description="For example the channel.">
          {(control) => (
            <Input
              {...control}
              value={name}
              maxLength={MAX_DESTINATION_NAME}
              placeholder="#agent-alerts"
              autoComplete="off"
              onChange={(event) => setName(event.currentTarget.value)}
            />
          )}
        </Field>
        <Field
          label="Webhook URL"
          description={
            <>
              In Slack, create an app, turn on Incoming Webhooks and copy the channel's URL.{" "}
              <a href={HOW_TO} target="_blank" rel="noreferrer" className="underline">
                Slack's guide
              </a>
            </>
          }
        >
          {(control) => (
            // A secret: shown as dots, and never again after it is saved.
            <Input
              {...control}
              type="password"
              value={url}
              placeholder="https://hooks.slack.com/services/…"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setUrl(event.currentTarget.value)}
            />
          )}
        </Field>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" className="self-start" loading={saving}>
          Add destination
        </Button>
      </form>
    </Section>
  );
}

function TestButton({
  projectId,
  destination,
}: {
  projectId: string;
  destination: AlertDestination;
}) {
  const router = useRouter();
  const [testing, startTest] = useTransition();
  return (
    <Button
      size="sm"
      loading={testing}
      onClick={() =>
        startTest(async () => {
          const result = await changeDestinationAction({
            projectId,
            action: "test",
            destinationId: destination.id,
          });
          toast(
            result.ok
              ? { title: `Test message sent to ${destination.name}`, tone: "success" }
              : {
                  title: "The test message was not sent",
                  description: result.error,
                  tone: "danger",
                },
          );
          // The result is kept with the destination, and a lost connection with the workspace.
          router.refresh();
        })
      }
    >
      Send test message
    </Button>
  );
}
