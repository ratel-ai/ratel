import { buildRollup, type Rollup, type TrackInput, type Transport } from "@ratel-ai/sdk";

/**
 * The Ratel cloud analytics client (ADR-0013) — the TypeScript mirror of the
 * Python SDK's `RatelClient`. Records one usage *rollup* per agent interaction
 * (assembled by `@ratel-ai/sdk`'s `buildRollup`) and ships it to
 * `POST {host}/api/v1/events` — the exact shape Ratel's dashboard renders.
 * Best-effort and batched; never throws into caller code, and absent an API key
 * it is a no-op.
 *
 * It also carries the opt-in chat channel (ADR-0014): `recordMessages` /
 * `trackConversation` ship conversation turns to `POST {host}/api/v1/chats` —
 * a second road beside `/events`, batched independently. Chat capture is OFF by
 * default; it only ships when `captureChats` (or `RATEL_CAPTURE_CHATS`) is set
 * AND the client can export (an api key is present, per ADR-0014 privacy).
 */

/** Read an environment variable without a hard dependency on Node's `process` types. */
function envVar(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.[name];
}

/** Parse a truthy/falsey env flag; `undefined` when unset or unrecognized. */
function envBool(name: string): boolean | undefined {
  const raw = envVar(name)?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return undefined;
}

/** Register a best-effort process-exit flush without depending on Node's `process` types. */
function onBeforeExit(handler: () => void): (() => void) | undefined {
  const proc = (
    globalThis as {
      process?: {
        on?: (event: string, handler: () => void) => void;
        off?: (event: string, handler: () => void) => void;
      };
    }
  ).process;
  if (!proc?.on) return undefined;
  proc.on("beforeExit", handler);
  return () => proc.off?.("beforeExit", handler);
}

/** A conversation turn the caller records (idiomatic camelCase). */
export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  /** Position in the conversation. Defaults to the array index when omitted. */
  seq?: number;
  /** When the turn happened; serialized to a snake_case `occurred_at` ISO string. */
  occurredAt?: Date | string;
}

/** Options for a single `recordMessages` / conversation handle call. */
export interface RecordMessagesOptions {
  /** Optional non-PII tags forwarded as the wire `metadata` field. */
  metadata?: Record<string, unknown>;
}

/** One turn on the wire — snake_case keys exactly as `POST /api/v1/chats` accepts. */
export interface ChatWireMessage {
  role: ChatMessage["role"];
  content: string;
  seq: number;
  occurred_at?: string;
}

/** One conversation's slice of turns on the wire (ADR-0014). */
export interface ChatPayload {
  conversation_id: string;
  messages: ChatWireMessage[];
  metadata?: Record<string, unknown>;
}

/** A small handle bound to one conversation id — see `RatelClient.trackConversation`. */
export interface ConversationHandle {
  readonly conversationId: string;
  /** Record a slice of this conversation's turns. Best-effort; never throws. */
  record(messages: ChatMessage[], opts?: RecordMessagesOptions): void;
  /** Flush everything buffered (events and chats). */
  flush(): Promise<void>;
}

export interface RatelClientOptions {
  apiKey?: string;
  host?: string;
  enabled?: boolean;
  /** Fraction of interactions to record, 0..1 (default 1 = all). */
  sampleRate?: number;
  /** Flush automatically once this many rollups (or chat payloads) are buffered (default 50). */
  flushAt?: number;
  /** Flush automatically this long after the last `track()` / `recordMessages()` (default 1000ms). */
  flushIntervalMs?: number;
  /** Per-request timeout for the default fetch transport (default 5000ms). */
  timeoutMs?: number;
  /** Override the network transport for events — primarily for tests. */
  transport?: Transport;
  /**
   * Opt-in (ADR-0014): capture conversation text and ship it to `/api/v1/chats`.
   * Off by default; also enabled by the `RATEL_CAPTURE_CHATS` env flag. Even when
   * on, `recordMessages` is a no-op unless the client can export (api key present).
   */
  captureChats?: boolean;
  /** Override the network transport for chats — primarily for tests. */
  chatTransport?: ChatTransport;
}

/** The seam a chat shipper plugs into — a batch of one-conversation payloads. */
export type ChatTransport = (batch: ReadonlyArray<ChatPayload>) => Promise<void> | void;

export class RatelClient {
  private readonly apiKey: string | undefined;
  private readonly eventsUrl: string;
  private readonly chatsUrl: string;
  private readonly enabled: boolean;
  private readonly captureChats: boolean;
  private readonly sampleRate: number;
  private readonly flushAt: number;
  private readonly flushIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly transport: Transport | undefined;
  private readonly chatTransport: ChatTransport | undefined;
  private buffer: Rollup[] = [];
  private chatBuffer: ChatPayload[] = [];
  private readonly warned = new Set<string>();
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private removeExitHandler: (() => void) | undefined;

  constructor(options: RatelClientOptions = {}) {
    this.apiKey = options.apiKey ?? envVar("RATEL_API_KEY");
    const host = (options.host ?? envVar("RATEL_HOST") ?? "https://cloud.ratel.sh").replace(
      /\/+$/,
      "",
    );
    this.eventsUrl = `${host}/api/v1/events`;
    this.chatsUrl = `${host}/api/v1/chats`;
    this.enabled = options.enabled ?? Boolean(this.apiKey);
    this.captureChats = options.captureChats ?? envBool("RATEL_CAPTURE_CHATS") ?? false;
    this.sampleRate = options.sampleRate ?? 1;
    this.flushAt = options.flushAt ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.transport = options.transport;
    this.chatTransport = options.chatTransport;
    // For real (network) usage, ship whatever is buffered when the process winds
    // down. Skipped under a custom transport so tests don't accumulate listeners.
    if (this.canExport && this.transport == null && this.chatTransport == null) {
      this.removeExitHandler = onBeforeExit(() => {
        void this.flush();
      });
    }
  }

  /** True when the client can ship on any channel: a transport is set, or it's enabled with a key. */
  get canExport(): boolean {
    return this.canShipEvents || this.canShipChats;
  }

  /** Events ship via their transport, or the default fetch path when enabled with a key. */
  private get canShipEvents(): boolean {
    return this.transport != null || (this.enabled && Boolean(this.apiKey));
  }

  /** Chats ship via their transport, or the default fetch path when enabled with a key. */
  private get canShipChats(): boolean {
    return this.chatTransport != null || (this.enabled && Boolean(this.apiKey));
  }

  /** Record one interaction's usage rollup. Best-effort; never throws. */
  track(input: TrackInput): void {
    if (!this.canShipEvents) return;
    if (this.sampleRate < 1 && Math.random() >= this.sampleRate) return;
    try {
      this.buffer.push(buildRollup(input));
      if (this.buffer.length >= this.flushAt) {
        void this.flush();
      } else {
        this.scheduleFlush();
      }
    } catch {
      // assembling/buffering must never break the caller
    }
  }

  /**
   * Record a slice of a conversation's turns (ADR-0014). Opt-in: a no-op unless
   * chat capture is enabled AND the client can export. Best-effort; never throws.
   * The full `messages` array is shipped — the server does all dedup (v1).
   */
  recordMessages(
    conversationId: string,
    messages: ChatMessage[],
    opts?: RecordMessagesOptions,
  ): void {
    if (!this.captureChats || !this.canShipChats) return;
    try {
      const payload = buildChatPayload(conversationId, messages, opts);
      if (payload === undefined) return;
      this.chatBuffer.push(payload);
      if (this.chatBuffer.length >= this.flushAt) {
        void this.flush();
      } else {
        this.scheduleFlush();
      }
    } catch {
      // assembling/buffering must never break the caller
    }
  }

  /** A small handle bound to `conversationId` — `record(messages)` and `flush()`. */
  trackConversation(conversationId: string): ConversationHandle {
    return {
      conversationId,
      record: (messages, opts) => {
        this.recordMessages(conversationId, messages, opts);
      },
      flush: () => this.flush(),
    };
  }

  /** Send everything buffered (events and chats). Resolves once the sends settle. */
  async flush(): Promise<void> {
    if (this.scheduled !== undefined) {
      clearTimeout(this.scheduled);
      this.scheduled = undefined;
    }
    await Promise.all([this.flushEvents(), this.flushChats()]);
  }

  private async flushEvents(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.sendEvents(batch);
    } catch {
      // best-effort: a failed send is dropped, never surfaced
    }
  }

  private async flushChats(): Promise<void> {
    if (this.chatBuffer.length === 0) return;
    const batch = this.chatBuffer;
    this.chatBuffer = [];
    try {
      await this.sendChats(batch);
    } catch {
      // best-effort: a failed send is dropped, never surfaced
    }
  }

  /** Stop background flushing and ship anything still buffered. */
  async shutdown(): Promise<void> {
    if (this.removeExitHandler) {
      this.removeExitHandler();
      this.removeExitHandler = undefined;
    }
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.scheduled !== undefined) return;
    const handle = setTimeout(() => {
      this.scheduled = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    // An unref'd timer never keeps the process alive on its own.
    (handle as unknown as { unref?: () => void }).unref?.();
    this.scheduled = handle;
  }

  private async sendEvents(batch: ReadonlyArray<Rollup>): Promise<void> {
    if (this.transport) {
      await this.transport(batch);
      return;
    }
    await this.post(this.eventsUrl, batch);
  }

  private async sendChats(batch: ReadonlyArray<ChatPayload>): Promise<void> {
    if (this.chatTransport) {
      await this.chatTransport(batch);
      return;
    }
    await this.post(this.chatsUrl, batch);
  }

  /** Default fetch transport: POST a JSON array, retry 5xx, drop 4xx, warn once. */
  private async post(url: string, batch: ReadonlyArray<unknown>): Promise<void> {
    const body = JSON.stringify(batch);
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    let delay = 200;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        if (response.ok) return;
        if (response.status >= 400 && response.status < 500) {
          // Bad key/payload — retrying won't help. Drop and warn once.
          this.warnOnce(
            `http_${response.status}`,
            `ratel: ingest rejected (${response.status}); dropping batch`,
          );
          return;
        }
        // 5xx — fall through to retry.
      } catch {
        if (attempt === 2) {
          this.warnOnce("network", "ratel: ingest unreachable; dropping batch");
        }
      } finally {
        clearTimeout(timer);
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 200));
        delay *= 2;
      }
    }
    this.warnOnce("retries", "ratel: ingest failed after retries; dropping batch");
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }
}

/** Shape one conversation slice for the wire (ADR-0014). Returns `undefined`
 * when there is nothing to ship (no messages). Assigns `seq` by index when the
 * caller omits it; serializes `occurredAt` to a snake_case `occurred_at` ISO. */
function buildChatPayload(
  conversationId: string,
  messages: ChatMessage[],
  opts?: RecordMessagesOptions,
): ChatPayload | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const wire: ChatWireMessage[] = [];
  messages.forEach((message, index) => {
    // Skip malformed elements (null / primitive) rather than dropping the whole
    // batch — best-effort. The original index is preserved as the `seq` default.
    if (message == null || typeof message !== "object") return;
    const entry: ChatWireMessage = {
      role: message.role,
      content: message.content,
      seq: message.seq ?? index,
    };
    if (message.occurredAt !== undefined) {
      entry.occurred_at =
        message.occurredAt instanceof Date
          ? message.occurredAt.toISOString()
          : String(message.occurredAt);
    }
    wire.push(entry);
  });
  if (wire.length === 0) return undefined;
  const payload: ChatPayload = { conversation_id: conversationId, messages: wire };
  if (opts?.metadata !== undefined) payload.metadata = opts.metadata;
  return payload;
}

let globalClient: RatelClient | null = null;

/** The process-wide client, created from the environment on first use. */
export function getClient(): RatelClient {
  if (globalClient === null) {
    globalClient = new RatelClient();
  }
  return globalClient;
}

/** Replace the process-wide client with one built from `options`, shutting down the old. */
export function configure(options: RatelClientOptions): RatelClient {
  const previous = globalClient;
  globalClient = new RatelClient(options);
  if (previous) void previous.shutdown();
  return globalClient;
}

/** Install (or clear) the process-wide client. Primarily for tests. */
export function setGlobalClient(client: RatelClient | null): void {
  globalClient = client;
}
