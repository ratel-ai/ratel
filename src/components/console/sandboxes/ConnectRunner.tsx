import { CodeBlock } from "@ratel/design-system/code";
import { SquareTerminal } from "lucide-react";

export const RATEL_DEV_COMMAND = "pnpm exec ratel sandbox dev";

/**
 * No runner, or a paused one: the command that connects one. `ratel` comes
 * with `@ratel-ai/sandbox`; it runs in the app folder, next to the sandbox files.
 */
export function ConnectRunner({ paused = false }: { paused?: boolean }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <SquareTerminal className="mb-3 size-5 text-fg-subtle" strokeWidth={1.5} aria-hidden />
      <p className="text-sm font-semibold text-fg">
        {paused ? "Your runner is paused" : "Connect a runner to use sandboxes"}
      </p>
      <p className="mt-1 max-w-md text-sm text-fg-muted">
        Run this in your app folder. It finds your sandbox files, connects to Ratel and runs each
        playground run on your machine, with your own keys.
      </p>
      <CodeBlock
        samples={[{ label: "Shell", code: RATEL_DEV_COMMAND }]}
        caption="Shell"
        className="mt-4 w-full max-w-md text-left"
      />
    </div>
  );
}
