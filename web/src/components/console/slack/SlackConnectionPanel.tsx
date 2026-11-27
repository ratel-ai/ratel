"use client";

import { Autocomplete } from "@ratel/design-system/autocomplete";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState, useTransition } from "react";
import { changeDestinationAction } from "@/app/(console)/project/[projectId]/alerts/actions";
import {
  disconnectSlackAction,
  slackChannelsAction,
} from "@/app/(console)/project/[projectId]/settings/notifications/actions";
import type { ChannelsResult } from "@/lib/views/slack/connection-actions";
import { CANNOT_STORE, SLACK_UNAVAILABLE, type SlackConnection } from "@/lib/views/slack/types";

export interface SlackState {
  /** There is an app to install. */
  configured: boolean;
  /** The edition supplies the app: nobody configures one here. */
  editionOwned: boolean;
  connection: SlackConnection | null;
  isAdmin: boolean;
  /** Where an admin configures the app. */
  settingsHref: string;
}

/** The organization's Slack: configure the app, connect a workspace, pick a channel. */
export function SlackConnectionPanel({
  projectId,
  canStore,
  slack,
}: {
  projectId: string;
  canStore: boolean;
  slack: SlackState;
}) {
  const { configured, editionOwned, connection, isAdmin, settingsHref } = slack;
  if (connection && !connection.lost)
    return <Connected projectId={projectId} connection={connection} isAdmin={isAdmin} />;

  const body = !canStore ? (
    <Callout tone="warning" title="Slack cannot be connected">
      {CANNOT_STORE}
    </Callout>
  ) : configured && !isAdmin ? (
    <p className="text-ui text-fg-muted">
      Ask an organization admin to connect Slack for this organization.
    </p>
  ) : configured ? (
    // A route handler that leaves the site: not a client navigation.
    <a
      href={`/api/integrations/slack/start?${new URLSearchParams({ projectId })}`}
      className={buttonVariants({ variant: "primary", className: "self-start" })}
    >
      {connection ? "Connect again" : "Add to Slack"}
    </a>
  ) : editionOwned ? (
    <p className="text-ui text-fg-muted">{SLACK_UNAVAILABLE}</p>
  ) : isAdmin ? (
    <Link href={settingsHref} className={buttonVariants({ className: "self-start" })}>
      Configure your Slack App
    </Link>
  ) : (
    <p className="text-ui text-fg-muted">
      No Slack app is configured. Ask an organization admin to configure it.
    </p>
  );
  return (
    <Section title="Slack" description="Send alerts to a channel of your workspace.">
      {connection ? (
        <Callout tone="danger" title={`Slack is disconnected from ${connection.teamName}`}>
          {isAdmin
            ? "Alerts do not reach its channels. Connect again."
            : "Alerts do not reach its channels."}
        </Callout>
      ) : null}
      {body}
    </Section>
  );
}

function Connected({
  projectId,
  connection,
  isAdmin,
}: {
  projectId: string;
  connection: SlackConnection;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function disconnect() {
    const result = await disconnectSlackAction(projectId);
    if (result.ok) toast({ title: "Disconnected Slack" });
    else toast({ title: result.error, tone: "danger" });
    router.refresh();
  }

  return (
    <Section
      title="Slack"
      description={`Connected to ${connection.teamName}, for every project of the organization.`}
      actions={
        isAdmin ? (
          <Button size="sm" className="text-danger" onClick={() => setOpen(true)}>
            Disconnect…
          </Button>
        ) : null
      }
    >
      <ChannelPicker projectId={projectId} />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Disconnect ${connection.teamName}?`}
        description="Every project of the organization stops sending alerts to its channels."
        confirmLabel="Disconnect Slack"
        onConfirm={disconnect}
      />
    </Section>
  );
}

function ChannelPicker({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [list, setList] = useState<ChannelsResult | null>(null);
  const [channelId, setChannelId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, startAdd] = useTransition();

  useEffect(() => {
    let current = true;
    void slackChannelsAction(projectId).then((result) => {
      if (!current) return;
      setList(result);
      // A token that Slack refuses is found here: the page then says so.
      if (!result.ok) router.refresh();
    });
    return () => {
      current = false;
    };
  }, [projectId, router]);

  function add(id: string) {
    setError(null);
    startAdd(async () => {
      const result = await changeDestinationAction({
        projectId,
        action: "add_channel",
        channelId: id,
      });
      if (!result.ok) {
        setError(result.error);
        router.refresh();
        return;
      }
      setChannelId("");
      toast(
        result.warning
          ? { title: "Added, but not reachable yet", description: result.warning, tone: "danger" }
          : { title: "Channel added", tone: "success" },
      );
      router.refresh();
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    add(channelId);
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Autocomplete
        label="Add a channel"
        placeholder={
          list === null ? "Reading the channels…" : adding ? "Adding…" : "Add a channel…"
        }
        items={(list?.ok ? list.channels : []).map(({ id, name, isPrivate }) => ({
          id,
          label: `#${name}`,
          hint: isPrivate ? "Private" : undefined,
        }))}
        empty={list === null ? "Reading the channels…" : "No channel matches"}
        onPick={({ id }) => add(id)}
        className="max-w-none"
      />
      {list && !list.ok ? (
        <p role="alert" className="text-xs text-danger">
          {list.error}
        </p>
      ) : null}
      {list?.ok && list.partial ? (
        <p className="text-xs text-fg-muted">
          The workspace has more channels than this list. Enter the channel ID of a missing one.
        </p>
      ) : null}
      <form noValidate onSubmit={submit}>
        <Field
          label="Channel ID"
          description="For a private channel that the app is not in: at the end of the channel's details in Slack."
        >
          {(control) => (
            <span className="flex items-center gap-2">
              <Input
                {...control}
                value={channelId}
                placeholder="C0123456789"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setChannelId(event.currentTarget.value)}
              />
              <Button type="submit" loading={adding}>
                Add
              </Button>
            </span>
          )}
        </Field>
      </form>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
