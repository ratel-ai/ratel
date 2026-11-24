"use client";

import { toast } from "@ratel/design-system/toast";
import { useCallback, useState } from "react";
import { changeDashboardAction } from "@/app/(console)/project/[projectId]/dashboards/actions";
import type { DashboardActionInput } from "@/lib/views/dashboards/actions";

type Change = DashboardActionInput extends infer T
  ? T extends { projectId: string }
    ? Omit<T, "projectId">
    : never
  : never;

/** One dashboard change: the changed dashboard's id, or null after a toast that says why not. */
export function useDashboardAction(projectId: string) {
  const [saving, setSaving] = useState(false);
  const change = useCallback(
    async (input: Change): Promise<string | null> => {
      setSaving(true);
      try {
        const result = await changeDashboardAction({ projectId, ...input } as DashboardActionInput);
        if (result.ok) return result.dashboardId;
        toast({ title: result.error, tone: "danger" });
      } catch {
        toast({ title: "Could not save the change. Try again.", tone: "danger" });
      } finally {
        setSaving(false);
      }
      return null;
    },
    [projectId],
  );
  return { change, saving };
}
