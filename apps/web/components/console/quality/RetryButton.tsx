"use client";

import { Button } from "@ratel/design-system/button";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

/** Reads the page again in place: a failed section retries without leaving it. */
export function RetryButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button size="sm" loading={pending} onClick={() => startTransition(() => router.refresh())}>
      Try again
    </Button>
  );
}
