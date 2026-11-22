import { manifestSandboxes, ownRunner, type SandboxesPageDeps } from "../page";
import {
  matchSandbox,
  type NotReplayable,
  type ReplaySource,
  type ReplaySourceResult,
  type SandboxMatch,
} from "./session-source";

/**
 * The loaders of session replay (RC-1110, spec §9): "Replay in sandbox" on a
 * session page, and the replay a sandbox page opens with `?session=`. The sandbox is
 * matched in the caller's own runner (a run goes only to its owner's runner).
 */

export interface SessionReplayDeps {
  listRunners: SandboxesPageDeps["listRunners"];
  /** The session as a replay source, read with the project's content opt-in. */
  sessionSource: (query: { projectId: string; sessionId: string }) => Promise<ReplaySourceResult>;
}

/** What the session page shows: a link to the matched sandbox, or why replay is not possible. */
export type ReplayLink =
  | { state: "ready"; href: string; sandboxId: string; by: SandboxMatch["by"]; turns: number }
  | { state: "unavailable"; message: string };

/** The replay a sandbox page opens with: the source and how its sandbox was matched, or why it cannot replay. */
export type SessionReplayModel =
  | { state: "ready"; source: ReplaySource; match: SandboxMatch | null }
  | { state: "unavailable"; sessionId: string; message: string };

export const NO_RUNNER_MESSAGE =
  "Start `ratel sandbox dev` with this agent's sandbox to replay this session.";
export const NOT_CHAT_MESSAGE =
  "Replay of a session needs a chat sandbox. This sandbox takes one structured input.";

export async function loadSessionReplayLink(
  scope: { projectId: string; externalId: string; sessionId: string },
  deps: SessionReplayDeps,
): Promise<ReplayLink> {
  const source = await deps.sessionSource({
    projectId: scope.projectId,
    sessionId: scope.sessionId,
  });
  if (!source.replayable) return { state: "unavailable", message: source.message };
  const runner = ownRunner(await deps.listRunners(scope.projectId), scope.externalId);
  if (!runner) return { state: "unavailable", message: NO_RUNNER_MESSAGE };
  const chatSandboxes = manifestSandboxes(runner.manifest).filter(
    (sandbox) => sandbox.input?.kind === "chat",
  );
  const match = matchSandbox(
    source,
    chatSandboxes.map((sandbox) => sandbox.id),
  );
  if (!match) return { state: "unavailable", message: noSandboxMessage(source) };
  return {
    state: "ready",
    href: replayHref(scope.projectId, match.sandboxId, scope.sessionId),
    sandboxId: match.sandboxId,
    by: match.by,
    turns: source.turns.length,
  };
}

/** The replay of `?session=` on a chat sandbox's page. */
export async function loadSessionReplay(
  scope: {
    projectId: string;
    sessionId: string;
    sandbox: { id: string; inputKind: "structured" | "chat" };
  },
  deps: Pick<SessionReplayDeps, "sessionSource">,
): Promise<SessionReplayModel> {
  if (scope.sandbox.inputKind !== "chat")
    return { state: "unavailable", sessionId: scope.sessionId, message: NOT_CHAT_MESSAGE };
  const source = await deps.sessionSource({
    projectId: scope.projectId,
    sessionId: scope.sessionId,
  });
  if (!source.replayable) return unavailable(source);
  return { state: "ready", source, match: matchSandbox(source, [scope.sandbox.id]) };
}

export function replayHref(projectId: string, sandboxId: string, sessionId: string): string {
  return `/project/${encodeURIComponent(projectId)}/sandboxes/${encodeURIComponent(sandboxId)}?session=${encodeURIComponent(sessionId)}`;
}

function noSandboxMessage(source: Pick<ReplaySource, "sandboxId" | "agentName">): string {
  const names = [
    source.sandboxId && `sandbox "${source.sandboxId}"`,
    source.agentName && `agent "${source.agentName}"`,
  ]
    .filter(Boolean)
    .join(" or ");
  return names
    ? `Your runner has no chat sandbox for ${names}.`
    : "This session names no sandbox or agent, so no sandbox matches it.";
}

function unavailable(source: NotReplayable): SessionReplayModel {
  return { state: "unavailable", sessionId: source.sessionId, message: source.message };
}
