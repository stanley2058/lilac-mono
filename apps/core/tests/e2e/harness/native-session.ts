import { ORPCError } from "@orpc/client";
import {
  MemoryNativeCache,
  NativeClient,
  createNativeHttpRPC,
  type ClientEvent,
  type NativeCache,
  type NativeThreadStore,
} from "../../../../../packages/client/src/index";
import {
  bootstrapReplySchema,
  type BootstrapReply,
  type DisplayStreamTarget,
  type NativeInput,
  type NativeTransport,
  type TurnSlot,
} from "@stanley2058/lilac-client-protocol";
import { withinRedisDeadline } from "../../../../../packages/event-bus/tests/helpers/isolated-redis";
import { OWNER } from "./core-process";

type DisplayMessage = Extract<TurnSlot, { kind: "ready" }>["messages"][number];
type DisplayPart = DisplayMessage["parts"][number];

/** A flattened, assertion-friendly view of one rendered turn. */
export type RenderedTurn = {
  turnId: string;
  state: string | undefined;
  user: string;
  assistant: string;
  activities: { kind: string; label: string; state: string; output?: string; detail?: string }[];
  questions: Extract<DisplayPart, { type: "data-question" }>[];
  workflows: Extract<DisplayPart, { type: "data-workflow" }>["data"][];
  inputStates: string[];
  messages: DisplayMessage[];
};

export function renderTurn(slot: Extract<TurnSlot, { kind: "ready" }>): RenderedTurn {
  const text = (role: string) =>
    slot.messages
      .filter((message) => message.role === role)
      .flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )
      .join("\n");
  const parts = slot.messages.flatMap((message) => message.parts);
  return {
    turnId: slot.turnId,
    state: slot.state,
    user: text("user"),
    assistant: text("assistant"),
    activities: parts.flatMap((part) =>
      part.type === "data-activity"
        ? [
            {
              kind: part.data.kind,
              label: part.data.label,
              state: part.data.state,
              ...(part.data.output !== undefined ? { output: part.data.output } : {}),
              ...(part.data.detail !== undefined ? { detail: part.data.detail } : {}),
            },
          ]
        : [],
    ),
    questions: parts.filter((part) => part.type === "data-question"),
    workflows: parts.flatMap((part) => (part.type === "data-workflow" ? [part.data] : [])),
    inputStates: parts.flatMap((part) =>
      part.type === "data-input-state" ? [part.data.state] : [],
    ),
    messages: slot.messages,
  };
}

export function renderStore(store: NativeThreadStore): RenderedTurn[] {
  const turns: RenderedTurn[] = [];
  for (const slotId of store.slotIds) {
    const slot = store.get(slotId);
    if (slot?.kind === "ready") turns.push(renderTurn(slot));
  }
  return turns;
}

export type SessionStyle =
  /** Browser: cookie only on the socket and RPC, Origin always present. */
  | "web"
  /** TUI and scripts: bearer header, no cookie. */
  | "bearer";

export type NativeSessionOptions = {
  style?: SessionStyle;
  transport?: NativeTransport;
  cache?: NativeCache;
  /** The server is an older release whose receipts may predate command ID echoes. */
  olderServer?: boolean;
  /** Base URL for connections, such as a fault proxy in front of Core. Origin stays Core's URL. */
  via?: string;
  /** Called for every socket the client opens; lets a test break the WebSocket lane. */
  interceptSocket?: (url: URL) => "allow" | "refuse";
};

export async function login(nativeUrl: string): Promise<{ token: string; cookie: string }> {
  const response = await fetch(`${nativeUrl}/api/auth/login`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${OWNER.username}:${OWNER.password}`)}` },
  });
  if (response.status !== 200) throw new Error(`Native login failed: ${response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Native login did not set a session cookie");
  const { token } = (await response.json()) as { token: string };
  return { token, cookie };
}

/**
 * Drives Core with the production `NativeClient`, wired the way the web app (cookie) or the TUI
 * (bearer) wires it.
 */
export class NativeSession {
  readonly client: NativeClient;
  readonly events: ClientEvent[] = [];
  readonly sockets: URL[] = [];
  private readonly releases: (() => void)[] = [];
  private constructor(
    readonly nativeUrl: string,
    readonly credentials: { token: string; cookie: string },
    readonly initial: BootstrapReply,
    private readonly options: NativeSessionOptions,
  ) {
    const headers = () => sessionHeaders(options.style, credentials, nativeUrl);
    const base = options.via ?? nativeUrl;
    const scope = {
      installationId: initial.installationId,
      principalId: initial.viewer.id,
      protocolVersion: 1,
      projectionVersion: 1,
    } as const;
    let pending: BootstrapReply | undefined = initial;
    this.client = new NativeClient({
      scope,
      transport: options.transport ?? initial.transport,
      cache: options.cache ?? new MemoryNativeCache(),
      openHttp: () => createNativeHttpRPC({ url: new URL("/api/rpc", base), headers }),
      openSocket: () => {
        const url = new URL("/api/socket", base);
        url.protocol = "ws:";
        this.sockets.push(url);
        if (options.interceptSocket?.(url) === "refuse") {
          // A proxy that rejects the upgrade: the closest Bun can get to a 426 from the browser.
          const refused = new URL(url);
          refused.pathname = "/api/socket-refused";
          return new WebSocket(refused, { headers: headers() } as never);
        }
        return new WebSocket(url, { headers: headers() } as never);
      },
      bootstrap: async (input: { threadId?: string }, signal: AbortSignal) => {
        const reply = pending;
        pending = undefined;
        return reply ?? fetchBootstrap(base, headers(), input.threadId, signal);
      },
      onEvent: (event: ClientEvent) => this.events.push(event),
    });
    if (initial.catalog.kind === "catalog")
      this.client.catalogs.put(scope, initial.catalog.catalog);
  }

  static async open(
    nativeUrl: string,
    options: NativeSessionOptions = {},
    existing?: { token: string; cookie: string },
  ): Promise<NativeSession> {
    // Local login allows five attempts per client per minute, so sessions share one login.
    const credentials = existing ?? (await login(nativeUrl));
    const initial = await fetchBootstrap(
      options.via ?? nativeUrl,
      sessionHeaders(options.style, credentials, nativeUrl),
      undefined,
    );
    const session = new NativeSession(nativeUrl, credentials, initial, options);
    await session.client.start();
    await session.online();
    return session;
  }

  async online(): Promise<void> {
    await this.until(
      () => this.client.connectionState === "online" && Boolean(this.client.rpc),
      "client online",
    );
  }

  async loggedOut(): Promise<void> {
    await this.until(() => this.client.connectionState === "logged-out", "client logged out");
  }

  get rpc() {
    const rpc = this.client.rpc;
    if (!rpc) throw new Error("Native client has no live connection");
    return rpc;
  }

  async createThread(title: string): Promise<string> {
    const thread = await this.rpc.threads.create({ commandId: crypto.randomUUID(), title });
    return thread.id;
  }

  watch(target: DisplayStreamTarget | string): NativeThreadStore {
    const resolved: DisplayStreamTarget =
      typeof target === "string" ? { kind: "thread", threadId: target } : target;
    this.releases.push(this.client.observeStream(resolved));
    return this.client.stream(resolved);
  }

  async send(
    threadId: string,
    text: string,
    extra: Partial<Omit<NativeInput, "threadId" | "text">> = {},
  ): Promise<string> {
    const input: NativeInput = {
      commandId: crypto.randomUUID(),
      threadId,
      text,
      mode: "prompt",
      historyGeneration: this.client.thread(threadId).checkpoint?.historyGeneration ?? 0,
      attachmentIds: [],
      skillIds: [],
      ...extra,
    };
    const outcome = await this.client.submit(input);
    if (outcome.kind !== "accepted")
      throw new Error(`Native input was not accepted: ${JSON.stringify(outcome)}`);
    // Clients correlate receipts to their optimistic sends by command ID.
    const echoed = outcome.receipt.commandId;
    if (echoed !== input.commandId && !(this.options.olderServer && echoed === undefined))
      throw new Error(
        `Receipt ${JSON.stringify(outcome.receipt)} does not echo ${input.commandId}`,
      );
    return input.commandId;
  }

  /** Resolves once the rendered stream satisfies the predicate. */
  async waitForTurns(
    store: NativeThreadStore,
    predicate: (turns: RenderedTurn[]) => boolean,
    label: string,
    timeoutMs = 30_000,
  ): Promise<RenderedTurn[]> {
    await withinRedisDeadline(
      new Promise<void>((resolve) => {
        const check = () => {
          if (!predicate(renderStore(store))) return false;
          stop();
          resolve();
          return true;
        };
        const stop = store.subscribe(() => void check());
        check();
      }),
      label,
      timeoutMs,
    ).catch((error: Error) => {
      throw new Error(
        `${error.message}\nRendered: ${JSON.stringify(renderStore(store), null, 2).slice(0, 6_000)}`,
      );
    });
    return renderStore(store);
  }

  /** Waits until `count` turns exist and the last one has settled. */
  async settled(
    store: NativeThreadStore,
    count: number,
    label = "turn settled",
  ): Promise<RenderedTurn[]> {
    return this.waitForTurns(
      store,
      (turns) =>
        turns.length >= count &&
        turns
          .slice(0, count)
          .every(
            (turn) =>
              turn.state === "complete" || turn.state === "failed" || turn.state === "canceled",
          ),
      label,
    );
  }

  async until(predicate: () => boolean, label: string): Promise<void> {
    await withinRedisDeadline(
      new Promise<void>((resolve) => {
        if (predicate()) return resolve();
        const stop = this.client.subscribe(() => {
          if (!predicate()) return;
          stop();
          resolve();
        });
      }),
      label,
    );
  }

  async close(): Promise<void> {
    for (const release of this.releases.splice(0)) release();
    await this.client.dispose();
  }
}

function sessionHeaders(
  style: SessionStyle | undefined,
  credentials: { token: string; cookie: string },
  nativeUrl: string,
): Record<string, string> {
  return (style ?? "web") === "web"
    ? { cookie: credentials.cookie, origin: nativeUrl }
    : { authorization: `Bearer ${credentials.token}` };
}

export async function fetchBootstrap(
  nativeUrl: string,
  headers: Record<string, string>,
  threadId: string | undefined,
  signal?: AbortSignal,
): Promise<BootstrapReply> {
  const url = new URL("/api/bootstrap", nativeUrl);
  if (threadId) url.searchParams.set("threadId", threadId);
  const response = await fetch(url, { headers, signal });
  // Map statuses the way apps/web/src/http.ts does, so NativeClient reacts as it would in a browser.
  switch (response.status) {
    case 200:
      return bootstrapReplySchema.parse(await response.json());
    case 401:
      throw new ORPCError("UNAUTHENTICATED", { message: "Sign in to continue" });
    case 403:
      throw new ORPCError("FORBIDDEN", { message: "Forbidden" });
    default:
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        message: `Bootstrap failed: ${response.status}`,
      });
  }
}
