"use client";

import { Button } from "@ratel/design-system/button";
import { Callout } from "@ratel/design-system/states";
import { STALE_BUILD_MESSAGE } from "@/lib/console/stale-build";

/** RC-526: shown in place of a failed section when the tab runs an older build than the server (lib/stale-build.ts). */
export function StaleBuildCallout({ className }: { className?: string }) {
  return (
    <Callout
      tone="info"
      title={STALE_BUILD_MESSAGE}
      className={className}
      action={
        <Button size="sm" data-reload-page onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    />
  );
}
