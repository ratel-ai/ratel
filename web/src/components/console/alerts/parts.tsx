"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Switch } from "@ratel/design-system/checkbox";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { type ReactNode, useOptimistic, useTransition } from "react";
import { changeAlertAction } from "@/app/(console)/project/[projectId]/alerts/actions";
import { STATE_LABELS } from "@/lib/views/alerts/format";
import type { AlertRule, AlertState } from "@/lib/views/alerts/types";

/** A rule as the pages get it: its dates are text. */
export type AlertItem = Omit<AlertRule, "stateChangedAt"> & { stateChangedAt: string | null };

const TONES = { ok: "success", alerting: "danger", no_data: "neutral" } as const;

export function StateBadge({ state }: { state: AlertState }) {
  return <StatusDot tone={TONES[state]} label={STATE_LABELS[state]} />;
}

/** On, or paused: it changes at once, and back when the save fails. */
export function PauseSwitch({
  projectId,
  alert,
  label,
}: {
  projectId: string;
  alert: Pick<AlertItem, "id" | "enabled">;
  label: ReactNode;
}) {
  const router = useRouter();
  const [shown, setShown] = useOptimistic(alert.enabled);
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      label={label}
      checked={shown}
      disabled={pending}
      onCheckedChange={(enabled) =>
        startTransition(async () => {
          setShown(enabled);
          const result = await changeAlertAction({
            projectId,
            action: "set_enabled",
            ruleId: alert.id,
            enabled,
          });
          if (!result.ok) toast({ title: result.error, tone: "danger" });
          router.refresh();
        })
      }
    />
  );
}
