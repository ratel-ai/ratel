"use client";

import { Switch } from "@ratel/design-system/checkbox";
import { toast } from "@ratel/design-system/toast";
import { useState, useTransition } from "react";
import { setContentOptInAction } from "@/app/(console)/(session-replay)/session-replay-actions";

/**
 * The per-project content opt-in (RC-177), on Settings > General. On, the
 * session page shows message text and What-if may replay the model. Admins
 * change it; members see it read-only.
 */
export function ContentOptIn({
  projectId,
  readContent,
  canChange,
}: {
  projectId: string;
  readContent: boolean;
  canChange: boolean;
}) {
  const [on, setOn] = useState(readContent);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function change(next: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setContentOptInAction(projectId, next);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOn(result.readContent);
      toast({
        title: result.readContent ? "Content reading is on" : "Content reading is off",
        description: result.readContent
          ? "Session pages show message text, and What-if can replay the model."
          : "Session pages show counts only, and What-if re-ranks only.",
        tone: "success",
      });
    });
  }

  return (
    <div className="flex max-w-xl flex-col gap-2">
      <Switch
        label="Read message content in session replay"
        checked={on}
        onCheckedChange={change}
        disabled={!canChange || pending}
      />
      <p className="text-ui text-fg-muted">
        {canChange
          ? "On, the session page shows the message text the agent's model calls kept, and What-if can replay the model on it. Off, both show counts only."
          : "Only organization admins can change content reading."}
      </p>
      {error ? (
        <p role="alert" className="text-ui text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
