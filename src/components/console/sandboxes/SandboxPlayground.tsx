"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Field, Textarea } from "@ratel/design-system/input";
import { type Crumb, Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Play, Plus, Square } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  CallableProviderView,
  PlaygroundSandbox,
  RecordedItemView,
  RunnerSummary,
} from "@/lib/views/sandboxes/page";
import {
  type ChatTurn,
  changedParams,
  chatMessages,
  chatTurn,
  chatTurnsFromRuns,
  initialRunView,
  inputSkeleton,
  paramDiff,
  paramErrors,
  paramOverrides,
  type RunViewAction,
  reduceRunView,
  runRequestBody,
} from "@/lib/views/sandboxes/playground-state";
import { replayArm } from "@/lib/views/sandboxes/replay";
import type { SessionReplayModel } from "@/lib/views/sandboxes/replay/session-page";
import { replayToolModes } from "@/lib/views/sandboxes/replay/turn-compare";
import {
  manifestTools,
  type ToolSetting,
  toolsParamOverrides,
} from "@/lib/views/sandboxes/tools-state";
import { ChatThread } from "./ChatThread";
import { CompareView } from "./CompareView";
import { ConfigPill } from "./ConfigPill";
import { ParamsPanel } from "./ParamsPanel";
import { RecordedItems } from "./RecordedItems";
import { RecordedOutput } from "./RecordedOutput";
import { RunList } from "./RunList";
import { RunnerStatus } from "./RunnerStatus";
import { RunOutput } from "./RunOutput";
import { SessionReplayView } from "./SessionReplayView";
import { ToolsPanel } from "./ToolsPanel";
import type { SandboxRunItem } from "./types";
import { useCompare } from "./useCompare";
import { useReplayPins } from "./useReplayPins";
import { useSessionReplay } from "./useSessionReplay";

export interface SandboxPlaygroundProps {
  projectId: string;
  crumbs: readonly Crumb[];
  runner: RunnerSummary;
  sandbox: PlaygroundSandbox;
  providers: readonly CallableProviderView[];
  defaultConfigHash: string | null;
  productionHash: string | null;
  /** The recorded item `?span=` opened ("Open in sandbox"), or null. */
  initialItem: RecordedItemView | null;
  /** The recorded session `?session=` opened ("Replay in sandbox"), or null. */
  initialReplay?: SessionReplayModel | null;
}

interface RunnerApiRow {
  id: string;
  mine: boolean;
  online: boolean;
  startable: boolean;
  maxConcurrency?: number;
  manifest: { sandboxes?: { id?: string }[] };
}

/** The run's SSE event kinds (sandbox/v1 `run.event` kinds and `run.end`). */
const EVENT_KINDS = [
  "text.delta",
  "tool.call",
  "tool.result",
  "log",
  "span.ref",
  "run.end",
] as const;
/** How often the page checks that the runner is still connected. */
const RUNNER_POLL_MS = 15_000;
const CLOCK_TICK_MS = 30_000;
/** The Recorded items list reads more than Compare takes, so a pick over 50 is refused in place. */
const RECORDED_ITEMS_LIMIT = 100;

/**
 * One sandbox's playground (spec §9): the runner and the config pill on top, the
 * caller's runs on the left, the input and the streamed output in the center
 * (a JSON form, or a chat for a chat sandbox), and the params and tools on the
 * right. Each run (one per chat message) starts on the caller's own runner
 * with only the changed params and tool modes, then follows its events over SSE.
 */
export function SandboxPlayground({
  projectId,
  crumbs,
  runner,
  sandbox,
  providers,
  defaultConfigHash,
  productionHash,
  initialItem,
  initialReplay = null,
}: SandboxPlaygroundProps) {
  const api = `/api/projects/${encodeURIComponent(projectId)}/sandboxes`;
  const [runnerId, setRunnerId] = useState(runner.id);
  const [online, setOnline] = useState(runner.online);
  const [maxConcurrency, setMaxConcurrency] = useState(runner.maxConcurrency);
  // The open recorded item: its input fills the form and its recorded output sits next to the new one.
  const [item, setItem] = useState<RecordedItemView | null>(initialItem);
  const [items, setItems] = useState<RecordedItemView[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const compare = useCompare(api, sandbox.id);
  const sessionReplay = useSessionReplay(api, sandbox.id);
  const replayPins = useReplayPins(api, sessionReplay.state.sessionId);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Null until the user types or loads a run or an item: then the last run's input, else a skeleton of the schema.
  const [editedInput, setEditedInput] = useState<string | null>(() =>
    initialItem ? JSON.stringify(initialItem.input, null, 2) : null,
  );
  const [inputError, setInputError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [runs, setRuns] = useState<SandboxRunItem[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [view, dispatch] = useReducer(reduceRunView, initialRunView);
  const source = useRef<EventSource | null>(null);
  const [toolSettings, setToolSettings] = useState<Record<string, ToolSetting>>({});
  // Chat sandboxes: the finished turns, and the message of the turn `view` shows (in flight or last).
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const isChat = sandbox.input.kind === "chat";
  const tools = useMemo(() => manifestTools(sandbox), [sandbox]);

  const changed = useMemo(() => changedParams(sandbox.params, values), [sandbox.params, values]);
  const diff = useMemo(() => paramDiff(sandbox.params, values), [sandbox.params, values]);
  const live = view.phase === "starting" || view.phase === "live";
  const comparing =
    compare.state.phase === "resolving" ||
    compare.state.phase === "running" ||
    sessionReplay.state.phase === "running";

  const lastInput = runs.find((r) => r.input !== null && r.input !== undefined)?.input;
  const inputText = editedInput ?? JSON.stringify(lastInput ?? startingInput(sandbox), null, 2);

  const applyRuns = useCallback((result: SandboxRunItem[] | null) => {
    if (result) setRuns(result);
    setRunsError(result ? null : "Couldn't load your runs. Reload the page to try again.");
    setRunsLoading(false);
  }, []);
  const runsUrl = `${api}/runs?sandboxId=${encodeURIComponent(sandbox.id)}`;
  const loadRuns = useCallback(() => fetchRuns(runsUrl).then(applyRuns), [runsUrl, applyRuns]);

  useEffect(() => {
    void fetchRuns(runsUrl).then(applyRuns);
  }, [runsUrl, applyRuns]);

  useEffect(() => {
    void fetchItems(
      `${api}/items?sandboxId=${encodeURIComponent(sandbox.id)}&limit=${RECORDED_ITEMS_LIMIT}`,
    ).then((result) => {
      if (result) setItems(result);
      setItemsError(
        result ? null : "Couldn't load the recorded items. Reload the page to try again.",
      );
      setItemsLoading(false);
    });
  }, [api, sandbox.id]);

  // A runner that goes away pauses the session; one of the caller's that comes back resumes it.
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch(`${api}/runners`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { runners: RunnerApiRow[] };
        const usable = body.runners.find(
          (r) => r.startable && (r.manifest.sandboxes ?? []).some((t) => t.id === sandbox.id),
        );
        if (usable) {
          setRunnerId(usable.id);
          setMaxConcurrency(Math.max(1, usable.maxConcurrency ?? 1));
        }
        setOnline(Boolean(usable));
      } catch {
        // A failed check keeps the last known state; the next one tries again.
      }
    };
    const timer = setInterval(() => void check(), RUNNER_POLL_MS);
    return () => clearInterval(timer);
  }, [api, sandbox.id]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => {
      clearInterval(timer);
      source.current?.close();
    };
  }, []);

  const follow = useCallback(
    (runId: string) => {
      source.current?.close();
      const events = new EventSource(`${api}/runs/${encodeURIComponent(runId)}/events`);
      source.current = events;
      for (const kind of EVENT_KINDS) {
        events.addEventListener(kind, (event) => {
          const message = event as MessageEvent<string>;
          const action: RunViewAction = {
            type: "event",
            seq: Number(message.lastEventId),
            kind,
            payload: parsePayload(message.data),
            at: Date.now(),
          };
          dispatch(action);
        });
      }
      events.onerror = () => {
        // EventSource reconnects by itself after a dropped connection (with
        // Last-Event-ID); CLOSED means the server refused the stream.
        if (events.readyState !== EventSource.CLOSED) return;
        dispatch({
          type: "status",
          status: "unknown",
          error: "Lost the run's live output. Its result shows in Runs when it ends.",
          at: Date.now(),
        });
        source.current = null;
        setCancelling(false);
        void loadRuns();
      };
      events.addEventListener("run.status", (event) => {
        const payload = parsePayload((event as MessageEvent<string>).data);
        dispatch({
          type: "status",
          status: String(payload.status ?? "unknown"),
          error: payload.error ?? null,
          at: Date.now(),
        });
        events.close();
        source.current = null;
        setCancelling(false);
        void loadRuns();
      });
    },
    [api, loadRuns],
  );

  async function run() {
    let input: unknown;
    try {
      input = JSON.parse(inputText);
    } catch {
      setInputError("The input is not valid JSON.");
      return;
    }
    setInputError(null);
    // A run of an open recorded item is a replay of its trace.
    await startRun(
      input,
      item ? { sourceTraceId: item.traceId, arm: replayArm(changed) } : undefined,
    );
  }

  /** One chat turn: the conversation so far plus the new message, as one run in the chat's session. */
  async function sendMessage(text: string) {
    const history =
      pendingMessage !== null ? [...chatTurns, chatTurn(pendingMessage, view)] : chatTurns;
    setChatTurns(history);
    setPendingMessage(text);
    await startRun({ messages: chatMessages(history, text) });
  }

  function newChat() {
    setSessionId(null);
    setChatTurns([]);
    setPendingMessage(null);
  }

  async function startRun(input: unknown, replay?: { sourceTraceId: string; arm: string }) {
    setErrors({});
    dispatch({ type: "starting" });
    let res: Response;
    try {
      res = await fetch(`${api}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          runRequestBody({
            runnerId,
            sandboxId: sandbox.id,
            sessionId,
            input,
            params: sandbox.params,
            values,
            tools,
            toolSettings,
            replay,
          }),
        ),
      });
    } catch {
      dispatch({
        type: "refused",
        message: "Couldn't reach Ratel. Check your connection and run again.",
      });
      return;
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 201 && body) {
      const started = body as {
        runId: string;
        sessionId: string;
        configHash: string;
        overrides: string[];
      };
      dispatch({
        type: "started",
        runId: started.runId,
        sessionId: started.sessionId,
        configHash: started.configHash,
        overrides: started.overrides,
        at: Date.now(),
      });
      setSessionId(started.sessionId);
      setSelectedRun(started.runId);
      void loadRuns();
      follow(started.runId);
      return;
    }
    dispatch({ type: "refused", message: refusalMessage(res.status, body) });
    if (body?.error === "invalid_params") setErrors(paramErrors(body));
    if (body?.error === "invalid_input")
      setInputError(String(body.message ?? "The input does not fit the sandbox's schema."));
    if (body?.error === "runner_offline") setOnline(false);
  }

  async function cancel() {
    if (!view.runId) return;
    setCancelling(true);
    const res = await fetch(`${api}/runs/${encodeURIComponent(view.runId)}/cancel`, {
      method: "POST",
    }).catch(() => null);
    // A run that ended meanwhile answers 409: its end is already on the stream.
    if (!res || (!res.ok && res.status !== 409)) setCancelling(false);
  }

  function openRun(run: SandboxRunItem) {
    // A chat in flight stays on screen until its run ends.
    if (isChat && live) return;
    setSelectedRun(run.id);
    if (isChat && run.sessionId) {
      setChatTurns(chatTurnsFromRuns(runs, run.sessionId));
      setPendingMessage(null);
    }
    setItem(null);
    if (run.input !== null && run.input !== undefined)
      setEditedInput(JSON.stringify(run.input, null, 2));
    setValues({ ...run.params });
    setErrors({});
    if (run.sessionId) setSessionId(run.sessionId);
  }

  function openItem(recorded: RecordedItemView) {
    setItem(recorded);
    setSelectedRun(null);
    setEditedInput(JSON.stringify(recorded.input, null, 2));
    setInputError(null);
    // The URL names the open item, so a refresh or a shared link opens it again.
    window.history.replaceState(null, "", `?span=${encodeURIComponent(recorded.spanId)}`);
  }

  function pickItems(spanIds: readonly string[], on: boolean) {
    setPicked((current) => {
      const next = new Set(current);
      for (const spanId of spanIds) {
        if (on) next.add(spanId);
        else next.delete(spanId);
      }
      return next;
    });
  }

  function startCompare() {
    void compare.start({
      spanIds: items
        .filter((recorded) => picked.has(recorded.spanId))
        .map((recorded) => recorded.spanId),
      runnerId,
      candidateParams: paramOverrides(sandbox.params, values),
      changed,
      maxConcurrency,
      onSettled: () => void loadRuns(),
    });
  }

  /** Replays the recorded session: one run per user message, in one arm or in both. */
  function startSessionReplay(withCompare: boolean) {
    if (initialReplay?.state !== "ready") return;
    void sessionReplay.start({
      runnerId,
      sourceSessionId: initialReplay.source.sessionId,
      turns: initialReplay.source.turns,
      compare: withCompare,
      candidateParams: {
        ...paramOverrides(sandbox.params, values),
        ...toolsParamOverrides(tools, toolSettings),
      },
      changed,
      toolModes: replayToolModes(tools, toolSettings),
      // Pins belong to the replay session: a run again stays in it, so both arms get them.
      sessionId: sessionReplay.state.sessionId,
      onSettled: () => void loadRuns(),
    });
  }

  function editParam(name: string, value: unknown) {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors(({ [name]: _cleared, ...rest }) => rest);
  }

  function resetParam(name: string) {
    setValues(({ [name]: _reset, ...rest }) => rest);
    setErrors(({ [name]: _cleared, ...rest }) => rest);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && online && !live) {
      event.preventDefault();
      void run();
    }
  }

  const liveRunner: RunnerSummary = { ...runner, id: runnerId, online };

  return (
    <Page>
      <PageHeader
        title={<span className="font-mono">{sandbox.id}</span>}
        crumbs={crumbs}
        actions={
          <>
            <RunnerStatus runner={liveRunner} />
            <ConfigPill
              diff={diff}
              configHash={changed.length === 0 ? defaultConfigHash : null}
              productionHash={productionHash}
              onResetAll={() => setValues({})}
            />
          </>
        }
      />
      <PageBody wide>
        <div className="grid gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_22rem]">
          <aside
            className="flex flex-col gap-6 max-lg:order-3"
            aria-label={isChat ? "Your runs" : "Recorded items and your runs"}
          >
            {isChat ? null : (
              <section className="flex flex-col gap-2" aria-label="Recorded items">
                <h2 className="text-sm font-semibold text-fg">Recorded items</h2>
                <RecordedItems
                  items={items}
                  loading={itemsLoading}
                  error={itemsError}
                  openSpanId={item?.spanId ?? null}
                  picked={picked}
                  now={now}
                  compareDisabled={!online || live || comparing}
                  onOpen={openItem}
                  onPick={pickItems}
                  onCompare={startCompare}
                />
              </section>
            )}
            <section className="flex flex-col gap-3" aria-label="Your runs">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-fg">Runs</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={isChat ? newChat : () => setSessionId(null)}
                  disabled={!sessionId || live}
                >
                  <Plus className="size-3.5" aria-hidden />
                  New session
                </Button>
              </div>
              {/* Capped, so a long session never pushes Compare off the page. */}
              <div className="max-h-[28rem] overflow-y-auto">
                <RunList
                  projectId={projectId}
                  runs={runs}
                  loading={runsLoading}
                  error={runsError}
                  productionHash={productionHash}
                  selectedId={selectedRun}
                  sessionId={sessionId}
                  now={now}
                  onOpen={openRun}
                />
              </div>
            </section>
          </aside>

          {isChat ? (
            <div className="flex min-w-0 flex-col gap-6">
              {initialReplay ? (
                <SessionReplayView
                  projectId={projectId}
                  replay={initialReplay}
                  state={sessionReplay.state}
                  changed={changed}
                  canRun={online && !live && !comparing}
                  onReplay={startSessionReplay}
                  onStop={sessionReplay.stop}
                  onClose={sessionReplay.close}
                  pins={replayPins.pins}
                  onPin={
                    sessionReplay.state.sessionId
                      ? (call, result, isError) => replayPins.pin(call, result, isError)
                      : undefined
                  }
                  onUnpin={replayPins.unpin}
                />
              ) : null}
              <ChatThread
                projectId={projectId}
                api={api}
                tools={tools}
                turns={chatTurns}
                pending={pendingMessage !== null ? { user: pendingMessage, view } : null}
                sessionId={sessionId}
                online={online}
                busy={live || comparing}
                cancelling={cancelling}
                onSend={(text) => void sendMessage(text)}
                onCancel={() => void cancel()}
                onNewChat={newChat}
              />
            </div>
          ) : (
            <section className="flex min-w-0 flex-col gap-6" aria-label="Input and output">
              <Field
                label={
                  <span className="flex items-center gap-2">
                    Input
                    <Badge>Structured</Badge>
                  </span>
                }
                error={inputError}
                description="JSON. Press ⌘Enter to run."
              >
                {(control) => (
                  <Textarea
                    {...control}
                    value={inputText}
                    onChange={(event) => {
                      setEditedInput(event.target.value);
                      setInputError(null);
                    }}
                    onKeyDown={onInputKeyDown}
                    spellCheck={false}
                    className="min-h-64 font-mono text-xs"
                  />
                )}
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  onClick={() => void run()}
                  disabled={!online || live || comparing}
                  loading={view.phase === "starting"}
                >
                  <Play className="size-3.5" aria-hidden />
                  {view.phase === "starting" ? "Starting…" : "Run"}
                </Button>
                {view.phase === "live" ? (
                  <Button onClick={() => void cancel()} loading={cancelling}>
                    <Square className="size-3.5" aria-hidden />
                    {cancelling ? "Canceling…" : "Cancel run"}
                  </Button>
                ) : null}
                {!online ? (
                  <span className="text-ui text-warning">
                    Your runner is paused. Start ratel sandbox dev again to run.
                  </span>
                ) : null}
                {changed.length > 0 ? (
                  <span className="text-xs text-fg-subtle">
                    Runs with {changed.length} changed {changed.length === 1 ? "param" : "params"}
                  </span>
                ) : null}
              </div>
              {item ? (
                <div className="grid gap-4 2xl:grid-cols-2">
                  <RecordedOutput projectId={projectId} item={item} onClose={() => setItem(null)} />
                  <section aria-label="New output" className="flex min-w-0 flex-col gap-3">
                    <h3 className="flex min-h-7 items-center text-sm font-semibold text-fg">
                      New output
                    </h3>
                    <RunOutput projectId={projectId} view={view} productionHash={productionHash} />
                  </section>
                </div>
              ) : (
                <RunOutput projectId={projectId} view={view} productionHash={productionHash} />
              )}
            </section>
          )}

          <aside className="flex flex-col gap-3 lg:col-span-2 xl:col-span-1" aria-label="Params">
            <ParamsPanel
              sandbox={sandbox}
              providers={providers}
              values={values}
              changed={changed}
              errors={errors}
              onChange={editParam}
              onReset={resetParam}
              tools={
                <ToolsPanel
                  tools={tools}
                  settings={toolSettings}
                  onChange={(name, setting) =>
                    setToolSettings((current) => ({ ...current, [name]: setting }))
                  }
                />
              }
            />
          </aside>
        </div>
        {compare.state.phase !== "idle" || compare.state.error ? (
          <CompareView
            projectId={projectId}
            state={compare.state}
            onStop={compare.stop}
            onClose={compare.close}
          />
        ) : null}
      </PageBody>
    </Page>
  );
}

/** The caller's runs of the sandbox, or null when the list could not be read. */
async function fetchRuns(url: string): Promise<SandboxRunItem[] | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { runs: SandboxRunItem[] }).runs;
  } catch {
    // Offline or aborted: the list shows its error and the next load tries again.
    return null;
  }
}

/** The sandbox's recorded items, or null when the list could not be read. */
async function fetchItems(url: string): Promise<RecordedItemView[] | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { items: RecordedItemView[] }).items;
  } catch {
    // Offline or aborted: the list shows its error.
    return null;
  }
}

function startingInput(sandbox: PlaygroundSandbox): unknown {
  if (sandbox.input.kind === "chat") return { messages: [{ role: "user", content: "" }] };
  return inputSkeleton(sandbox.input.schema);
}

function parsePayload(data: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A frame that is not JSON carries nothing to show.
    return {};
  }
}

function refusalMessage(status: number, body: Record<string, unknown> | null): string {
  const error = body?.error;
  if (error === "invalid_params") return "Some params are not valid. Fix them and run again.";
  if (error === "invalid_input") return "The input does not fit the sandbox's schema.";
  if (error === "runner_offline")
    return "Your runner is paused. Start ratel sandbox dev again to run.";
  if (error === "unknown_sandbox")
    return "Your runner no longer has this sandbox. Check the sandbox file and reload.";
  if (error === "session_not_owner")
    return "This session belongs to another sandbox or person. Start a new session.";
  if (status === 401) return "Your session ended. Sign in again.";
  return "Couldn't start the run. Try again in a moment.";
}
