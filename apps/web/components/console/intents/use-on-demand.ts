"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { captureClientException } from "@/lib/platform/track-client";

type Answer = { ok: true } | { ok: false; message: string };

export type OnDemand<R extends Answer> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: Extract<R, { ok: true }> }
  | { status: "error"; message: string };

/**
 * A server action read once its view is on screen (what the engine read from
 * people's asks stays out of the server-rendered page), and again only when
 * `key` changes. The action is bound on the page, and every server action on
 * a project page ends in a refresh that hands over a new copy of it, so its
 * identity is not followed: following it would read forever. Without a
 * `read` it stays idle. A thrown read is a bug or an outage: reported, never
 * dropped, then shown as `failed`.
 */
export function useOnDemand<R extends Answer>(
  read: (() => Promise<R>) | undefined,
  key: string,
  failed: string,
): OnDemand<R> {
  const pathname = usePathname();
  const [state, setState] = useState<OnDemand<R>>(
    read ? { status: "loading" } : { status: "idle" },
  );
  const pathRef = useRef(pathname);
  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  }, [read]);
  const enabled = read !== undefined;
  useEffect(() => {
    const current = readRef.current;
    if (!current) return;
    let cancelled = false;
    current().then(
      (result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? { status: "ready", result: result as Extract<R, { ok: true }> }
            : { status: "error", message: result.message },
        );
      },
      (error: unknown) => {
        captureClientException(error, {
          digest: null,
          pathname: pathRef.current ?? "",
          boundary: "app",
        });
        if (!cancelled) setState({ status: "error", message: failed });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, enabled, failed]);
  return state;
}
