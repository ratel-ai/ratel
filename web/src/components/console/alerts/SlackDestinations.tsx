"use client";

import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { changeDestinationAction } from "@/app/(console)/project/[projectId]/alerts/actions";
import { type AlertDestination, MAX_DESTINATION_NAME } from "@/lib/views/alerts/types";

const HOW_TO = "https://api.slack.com/messaging/webhooks";

/** Settings > Notifications: the Slack channels the project's alerts go to. */
export function SlackDestinations({
  projectId,
  destinations,
  canStore,
}: {
  projectId: string;
  destinations: readonly AlertDestination[];
  /** Whether this deployment can keep a webhook URL. */
  canStore: boolean;
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

  const columns: Column<AlertDestination>[] = [
    { id: "name", header: "Name", className: "w-full", cell: (row) => row.name },
    {
      id: "url",
      header: "Webhook URL",
      width: "14rem",
      hiddenBelow: "sm",
      cell: (row) => (
        <span className="font-mono text-xs whitespace-nowrap text-fg-muted">
          {`hooks.slack.com/…${row.lastFour}`}
        </span>
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
      <Section title="Slack" description="The channels your alerts can go to.">
        {destinations.length > 0 ? (
          <DataTable
            caption="Slack destinations"
            columns={columns}
            rows={destinations}
            rowKey={(row) => row.id}
          />
        ) : (
          <p className="text-ui text-fg-muted">No Slack destination yet.</p>
        )}
      </Section>
      {canStore ? (
        <AddDestination projectId={projectId} />
      ) : (
        <Callout tone="warning" title="This deployment cannot store secrets">
          Set RATEL_SECRET_KEY and restart it to add a Slack destination.
        </Callout>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Remove ${removing?.name ?? ""}?`}
        description="Alerts that use it stop sending there. The stored webhook URL is deleted."
        confirmLabel="Remove destination"
        onConfirm={remove}
      />
    </PageBody>
  );
}

function AddDestination({ projectId }: { projectId: string }) {
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
    <Section title="Add a destination">
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
        })
      }
    >
      Send test message
    </Button>
  );
}
