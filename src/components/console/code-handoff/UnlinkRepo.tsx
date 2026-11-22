"use client";

import { Button } from "@ratel/design-system/button";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { unlinkRepoAction } from "@/app/(console)/project/[projectId]/settings/repository/actions";

/** Unlink the project's repo. Reversible (link it again), so no typed confirmation. */
export function UnlinkRepo({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function unlink() {
    setBusy(true);
    try {
      const result = await unlinkRepoAction(projectId);
      if (!result.ok) {
        toast({
          title: "Couldn't unlink the repository",
          description: result.error,
          tone: "danger",
        });
        return;
      }
      toast({ title: "Repository unlinked" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={unlink} loading={busy}>
      Unlink
    </Button>
  );
}
