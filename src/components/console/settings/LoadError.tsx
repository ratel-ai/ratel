"use client";

import { Button } from "@ratel/design-system/button";
import { Callout } from "@ratel/design-system/states";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

/**
 * A section that could not be read (DESIGN.md, Errors): what failed, and a
 * retry, in place of the section. The rest of the page keeps working. The
 * failure itself was already logged and reported where the read ran.
 */
export function LoadError({ what, className }: { what: string; className?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Callout
      tone="danger"
      title={`Couldn't load ${what}`}
      className={className}
      action={
        <Button size="sm" loading={pending} onClick={() => startTransition(() => router.refresh())}>
          Try again
        </Button>
      }
    >
      Try again in a moment.
    </Callout>
  );
}
