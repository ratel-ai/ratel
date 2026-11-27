"use client";

import { Callout } from "@ratel/design-system/states";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { captureClientException } from "@/lib/platform/track-client";

/**
 * Keeps one panel of the session replay (the context lens, the inspector,
 * What if…) from taking the page down with it (RTL-368): a render error in
 * the panel shows a short note in its place, the rest of the replay keeps
 * working, and the error is reported like the app's own boundary reports one.
 * A new `resetKey` (the next step) tries the panel again.
 */
export class PanelBoundary extends Component<
  { name: string; resetKey?: string | number | null; children?: ReactNode },
  { error: Error | null; key: string | number | null | undefined }
> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { resetKey?: string | number | null },
    state: { error: Error | null; key: string | number | null | undefined },
  ) {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[session-replay] ${this.props.name} failed:`, error);
    captureClientException(error, {
      boundary: "session-replay",
      panel: this.props.name,
      pathname: typeof window === "undefined" ? null : window.location.pathname,
      componentStack: info.componentStack ?? null,
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Callout tone="warning" title={`The ${this.props.name} could not be shown`}>
        The rest of the replay still works. Move to another step to try again.
      </Callout>
    );
  }
}
