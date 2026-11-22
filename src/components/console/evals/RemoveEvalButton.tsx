"use client";

import { IconButton } from "@ratel/design-system/button";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ratel/design-system/menu";
import { toast } from "@ratel/design-system/toast";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { removeEvalAction } from "@/lib/views/evals/actions";
import { evalsHref } from "@/lib/views/evals/paths";

/**
 * Remove an eval from the suite (RC-315): archived, out of every run, and a
 * suggestion never comes back. RC-657: it sits in a "More actions" menu, so
 * the header keeps one primary action (UX audit RC-656, P3).
 */
export function RemoveEvalButton({
  projectId,
  evalId,
  name,
}: {
  projectId: string;
  evalId: string;
  name: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Menu>
        <MenuTrigger
          render={<IconButton label="More actions" size="icon-sm" icon={<MoreHorizontal />} />}
        />
        <MenuContent align="end">
          <MenuItem tone="danger" icon={<Trash2 />} onClick={() => setOpen(true)}>
            Remove eval
          </MenuItem>
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Remove ${name}?`}
        description="It leaves the suite and no run includes it again. Its past results stay in their runs."
        confirmLabel="Remove eval"
        onConfirm={async () => {
          const result = await removeEvalAction(projectId, evalId);
          if (!result.ok) {
            toast({
              title: "Could not remove the eval",
              description: result.error,
              tone: "danger",
            });
            return;
          }
          setOpen(false);
          router.push(evalsHref(projectId));
        }}
      />
    </>
  );
}
