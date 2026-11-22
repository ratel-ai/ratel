"use client";

import { Switch } from "@ratel/design-system/checkbox";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setNightlyEvalsAction } from "@/lib/views/evals/actions";
import type { NightlySetting } from "@/lib/views/evals/nightly";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Nightly runs of the suite (RC-299): admins on paid plans only; `control` is null for everyone else. */
export function NightlyToggle({
  projectId,
  control,
  capUsd,
}: {
  projectId: string;
  control: NightlySetting | null;
  capUsd: number;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(control?.enabled ?? false);
  const [pending, start] = useTransition();
  if (!control) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Switch
        label="Run nightly"
        checked={enabled}
        disabled={pending}
        onCheckedChange={(next) =>
          start(async () => {
            const result = await setNightlyEvalsAction(projectId, next);
            if (!result.ok) {
              toast({
                title: "Could not change nightly runs",
                description: result.error,
                tone: "danger",
              });
              return;
            }
            setEnabled(result.value.enabled);
            router.refresh();
          })
        }
      />
      <p className="flex-1 text-ui text-fg-muted">
        Every approved eval runs once a day against the agent as recorded, up to{" "}
        {USD.format(capUsd)} a day for this project.
        {control.setAt ? ` Changed ${DAY.format(control.setAt)}.` : ""}
      </p>
    </div>
  );
}
