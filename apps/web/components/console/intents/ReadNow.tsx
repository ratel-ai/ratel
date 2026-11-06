"use client";

import { Button } from "@ratel/design-system/button";
import { toast } from "@ratel/design-system/toast";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { captureClientException } from "@/lib/platform/track-client";

export type ReadingRequest = () => Promise<
  { ok: true; coalesced: boolean } | { ok: false; message: string }
>;

/**
 * "Read now": queue an intents reading instead of waiting for the next Agent
 * health reading. The label stays while it is sent ("Reading…"), and the page
 * reads itself again so it turns into the reading once it is written.
 */
export function ReadNow({
  request,
  variant = "primary",
  label = "Read now",
}: {
  request: ReadingRequest;
  variant?: "primary" | "secondary";
  label?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [sending, setSending] = useState(false);
  const [, startTransition] = useTransition();
  return (
    <Button
      variant={variant}
      loading={sending}
      onClick={async () => {
        setSending(true);
        try {
          const result = await request();
          if (result.ok) {
            toast({
              title: result.coalesced
                ? "A reading is already on its way"
                : "Reading what people ask",
              description: "Intents fill in when it finishes, usually within a minute.",
              tone: "success",
            });
            startTransition(() => router.refresh());
          } else {
            toast({
              title: "Couldn't start a reading",
              description: result.message,
              tone: "danger",
            });
          }
        } catch (error) {
          // Reported, never dropped: the action itself answers failures, so this is a bug or an outage.
          captureClientException(error, {
            digest: null,
            pathname: pathname ?? "",
            boundary: "app",
          });
          toast({
            title: "Couldn't start a reading",
            description: "Try again in a moment.",
            tone: "danger",
          });
        } finally {
          setSending(false);
        }
      }}
    >
      {sending ? "Reading…" : label}
    </Button>
  );
}
