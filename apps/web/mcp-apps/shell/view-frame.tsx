"use client";

import { Callout, EmptyState, Skeleton } from "@ratel/design-system/states";
import { CircleSlash } from "lucide-react";
import type { ReactNode } from "react";
import type { McpAppBinding } from "@/lib/mcp/apps/types";
/**
 * The states every view shows the same way (DESIGN.md, States): a skeleton
 * while the call runs, the server's own message when it fails, a quiet line
 * when it was cancelled. A view renders only its ready state.
 */
import { APP_NAME } from "@/lib/platform/app-config";
import { type RatelView, useRatelView } from "./bridge";
import type { ToolSuccess } from "./state";

/** What the server's error codes mean to someone looking at the view. */
const ERROR_TITLES: Record<string, string> = {
  unauthorized: "Sign in again",
  forbidden: "Not available for this account",
  not_found: "Not found",
  rate_limited: "Too many requests",
  unavailable: `${APP_NAME} is unavailable`,
  invalid_params: "That request was not valid",
  host_unavailable: "Not connected",
};

export function DefaultSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-1" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-5/6" />
    </div>
  );
}

export function ViewFrame<T = unknown, B extends McpAppBinding = McpAppBinding>({
  children,
  skeleton = <DefaultSkeleton />,
}: {
  children: (result: ToolSuccess<T>, view: RatelView<T, B>) => ReactNode;
  skeleton?: ReactNode;
}) {
  const view = useRatelView<T, B>();
  const { state } = view;
  let body: ReactNode;
  if (state.status === "error" && state.error) {
    body = (
      <Callout tone="danger" title={ERROR_TITLES[state.error.code] ?? "Something went wrong"}>
        {state.error.message}
      </Callout>
    );
  } else if (state.status === "cancelled") {
    body = (
      <EmptyState
        icon={CircleSlash}
        title="Cancelled"
        description={state.reason ?? "The call was stopped before it finished."}
      />
    );
  } else if (state.status === "ready" && state.result) {
    body = children(state.result, view);
  } else {
    body = skeleton;
  }
  // The console's app surface and PageBody's paddings (components/ds/page-header.tsx).
  return <main className="bg-app px-6 py-6 text-sm text-fg antialiased lg:px-8">{body}</main>;
}
