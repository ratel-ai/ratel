import type { FakeLedger, RecordedCall } from "../domain/fake";

/**
 * What the fake service reads and writes: the run it answers for, pins,
 * recorded calls, production examples, the session ledger and the daily count.
 * Every read of recorded calls and examples leaves out fake results: a fake
 * never becomes the source of a later fake.
 */
export interface FakeStore {
  /** The run a request belongs to, or null when it is unknown. */
  runContext(runId: string): Promise<FakeRunContext | null>;
  /** The value the reviewer pinned for this tool and these normalized arguments in the session. */
  pinned(
    sessionId: string,
    tool: string,
    argsKey: string,
  ): Promise<{ result: unknown; isError: boolean } | null>;
  /** Who a session belongs to, for the pin route's owner check. */
  sessionOwner(sessionId: string): Promise<{ projectId: string; ownerUserId: string } | null>;
  /** Pins a value for this tool and these normalized arguments in the session (replaces an earlier pin). */
  pin(input: PinInput): Promise<void>;
  /** The session's pins, newest first. */
  pins(sessionId: string): Promise<SessionPin[]>;
  /** Removes one pin of the session; false when there was none. */
  unpin(sessionId: string, tool: string, argsKey: string): Promise<boolean>;
  /**
   * Recorded calls of this tool that may answer the request, newest first: real
   * and approved calls of the session's runs, then `execute_tool` spans of the
   * replay source. Never fake results.
   */
  recordedCalls(query: RecordedQuery): Promise<RecordedCall[]>;
  /** Recent production results of this tool in the project, newest first. Never spans with `ratel.tool.mode=fake`. */
  productionExamples(projectId: string, tool: string): Promise<RecordedCall[]>;
  ledger(sessionId: string): Promise<FakeLedger>;
  saveLedger(sessionId: string, ledger: FakeLedger): Promise<void>;
  /** Counts one generated fake for the project on the UTC day and returns the day's count after it. */
  countGenerated(projectId: string, day: string): Promise<number>;
}

export interface FakeRunContext {
  runId: string;
  projectId: string;
  organizationId: string | null;
  sessionId: string | null;
  input: unknown;
  replay: { sourceTraceId?: string; sourceSessionId?: string } | null;
}

export interface RecordedQuery {
  projectId: string;
  sessionId: string | null;
  tool: string;
  replay: FakeRunContext["replay"];
}

export interface PinInput {
  sessionId: string;
  tool: string;
  argsKey: string;
  result: unknown;
  isError: boolean;
  pinnedBy: string;
}

export interface SessionPin {
  tool: string;
  argsKey: string;
  /** The arguments the pin answers (the parsed `argsKey`). */
  args: unknown;
  result: unknown;
  isError: boolean;
  createdAt: Date;
}
