"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { compareHref } from "@/lib/views/evals/paths";

/** Which experiment is the baseline: this one, another one, or none. */
export type BaselineState = "this" | "other" | "none";

/** Pins a completed experiment, removes the pin, and opens the comparison. */
export function BaselineActions({
  projectId,
  experimentId,
  baseline,
  canEdit,
}: {
  projectId: string;
  experimentId: string;
  baseline: BaselineState;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(method: "PUT" | "DELETE") {
    setPending(true);
    setError(null);
    const path = `/api/projects/${projectId}/evals/baseline`;
    // Only the pin that this page shows: another person can have pinned another experiment.
    const response = await fetch(method === "PUT" ? path : `${path}?experimentId=${experimentId}`, {
      method,
      ...(method === "PUT"
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ experimentId }),
          }
        : {}),
    }).catch(() => null);
    if (response?.ok || response?.status === 409) router.refresh();
    if (response?.status === 409) setError("Another person changed the baseline.");
    else if (!response?.ok) setError("The baseline did not change. Try again.");
    setPending(false);
  }

  return (
    <>
      {error ? (
        <span role="alert" className="text-ui text-danger">
          {error}
        </span>
      ) : null}
      {canEdit ? (
        <Button loading={pending} onClick={() => send(baseline === "this" ? "DELETE" : "PUT")}>
          {baseline === "this" ? "Unpin baseline" : "Pin as baseline"}
        </Button>
      ) : null}
      {baseline === "other" ? (
        <Link
          href={compareHref(projectId, experimentId)}
          className={buttonVariants({ variant: "primary" })}
        >
          Compare with baseline
        </Link>
      ) : null}
    </>
  );
}
