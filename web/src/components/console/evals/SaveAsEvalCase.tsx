"use client";

import { Button } from "@ratel/design-system/button";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { caseHref } from "@/lib/views/evals/paths";

/** Saves a turn as a draft case and opens it. */
export function SaveAsEvalCase({ projectId, turnId }: { projectId: string; turnId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true);
    const failed = (description: string) => {
      setPending(false);
      toast({ title: "The case was not saved", description, tone: "danger" });
    };
    try {
      const response = await fetch(`/api/projects/${projectId}/evals/cases`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId }),
      });
      const body = (await response.json()) as { caseId?: string; message?: string };
      if (response.ok && body.caseId) router.push(caseHref(projectId, body.caseId));
      else failed(body.message ?? "Try again.");
    } catch {
      failed("Try again.");
    }
  }

  return (
    <Button size="sm" variant="secondary" onClick={save} disabled={pending}>
      {pending ? "Saving…" : "Save as eval case"}
    </Button>
  );
}
