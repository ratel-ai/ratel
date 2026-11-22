import type { ResolveContext, Sandbox } from "../sandbox.js";
import type { ConfirmAnswer, FakeAnswer, FakeRequest, ToolChannel } from "../tools.js";

// The tool channel of a local `ratel sandbox run`. There is no playground: a fake
// comes from a --fake file, else the sandbox's resolver generates it with the
// user's own key. A confirm has no reviewer, so it is rejected.

export function localToolChannel(
  sandbox: Sandbox,
  fakes: Readonly<Record<string, unknown>>,
  note: (line: string) => void,
  context: ResolveContext = {},
): ToolChannel {
  return {
    async fake(request: FakeRequest, signal: AbortSignal): Promise<FakeAnswer> {
      if (Object.hasOwn(fakes, request.tool))
        return { result: fakes[request.tool], isError: false, source: "pinned" };
      const generate = sandbox.resolve?.generateFake;
      if (!generate) {
        throw new Error(
          `no fake for ${request.tool}: pass --fake ${request.tool}=<file.json>, or use a resolver that can generate one`,
        );
      }
      return generate(request, signal, context);
    },
    async confirm(request): Promise<ConfirmAnswer> {
      note(
        `${request.tool}: confirm needs a reviewer, so a local run rejects it. Use --tool ${request.tool}=fake, or run it with ratel sandbox dev`,
      );
      return { decision: "reject" };
    },
  };
}
