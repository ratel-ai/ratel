"use client";

import { Button } from "@ratel/design-system/button";
import { Input } from "@ratel/design-system/input";
import type { SelectProps } from "@ratel/design-system/select";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { type AgentOverrideChange, MAX_DISPLAY_NAME } from "@/lib/views/agents/domain/overrides";

/**
 * An admin's corrections to one detected agent (RC-776): rename it, hide it,
 * merge its key into another agent, or undo a merge into it. Each change is
 * one `PUT` to the overrides route; the page re-reads after it.
 */
export function AgentOverrideControls({
  apiHref,
  agentKey,
  displayName,
  hidden,
  mergedKeys,
  mergeTargets,
}: {
  apiHref: string;
  agentKey: string;
  /** The override name, or null when the agent shows its key. */
  displayName: string | null;
  hidden: boolean;
  /** Keys merged into this agent: each one can be split back out. */
  mergedKeys: readonly string[];
  /** The agents this one can merge into. */
  mergeTargets: readonly { key: string; name: string }[];
}) {
  const router = useRouter();
  const [name, setName] = useState(displayName ?? "");
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function change(body: AgentOverrideChange) {
    setError(null);
    startTransition(async () => {
      const response = await fetch(apiHref, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
      } | null;
      if (!response.ok || !result?.ok) {
        setError(result?.message ?? "The change was not saved. Try again.");
        return;
      }
      setTarget(null);
      router.refresh();
    });
  }

  const renamed = name.trim() !== (displayName ?? "");
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
      aria-label="Correct this agent"
    >
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          change({ agentKey, displayName: name.trim() || null });
        }}
      >
        <label htmlFor="agent-display-name" className="text-ui text-fg-muted">
          Display name
        </label>
        <Input
          id="agent-display-name"
          className="w-64"
          value={name}
          maxLength={MAX_DISPLAY_NAME}
          placeholder={agentKey}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={!renamed} loading={pending && renamed}>
          {name.trim() ? "Rename" : "Use the detected name"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => change({ agentKey, hidden: !hidden })}
        >
          {hidden ? "Show this agent" : "Hide this agent"}
        </Button>
      </form>

      {mergedKeys.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-ui">
          <span className="text-fg-muted">Merged into this agent:</span>
          {mergedKeys.map((key) => (
            <span key={key} className="inline-flex items-center gap-1">
              <span className="font-mono text-fg">{key}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => change({ agentKey: key, mergedInto: null })}
              >
                Undo merge
              </Button>
            </span>
          ))}
        </div>
      ) : mergeTargets.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui text-fg-muted">Same agent as</span>
          <Select {...mergePickerProps(mergeTargets, setTarget)} />
          <Button
            size="sm"
            disabled={!target || pending}
            onClick={() => target && change({ agentKey, mergedInto: target })}
          >
            Merge
          </Button>
        </div>
      ) : null}

      {error ? (
        <Callout tone="danger" title="Not saved">
          {error}
        </Callout>
      ) : null}
    </fieldset>
  );
}

/**
 * The merge picker's props. Uncontrolled for its whole life: no `value`, the
 * choice is read through `onValueChange`. A `value` that starts undefined and
 * then gets set switches Base UI's Select from uncontrolled to controlled,
 * which logs a console error (the dev overlay "1 Issue" of RC-776's proof).
 * The form is keyed per agent, so it resets after a merge.
 */
export function mergePickerProps(
  targets: readonly { key: string; name: string }[],
  onPick: (key: string) => void,
): SelectProps {
  return {
    "aria-label": "Merge into",
    placeholder: "Choose an agent…",
    onValueChange: onPick,
    options: targets.map((entry) => ({ value: entry.key, label: entry.name })),
  };
}
