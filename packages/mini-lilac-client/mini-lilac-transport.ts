import {
  DefaultChatTransport,
  parseJsonEventStream,
  uiMessageChunkSchema,
  type ChatTransport,
  type UIMessageChunk,
} from "ai";
import { z } from "zod";

import {
  type MiniLilacCancelRequest,
  type MiniLilacCancelResult,
  type MiniLilacChatRequestExtras,
  type MiniLilacCompactInput,
  type MiniLilacCompactResult,
  type MiniLilacInterruptQueuedSteeringInput,
  type MiniLilacInterruptQueuedSteeringResult,
  type MiniLilacModelSummary,
  type MiniLilacProfileSummary,
  type MiniLilacSessionResume,
  type MiniLilacSessionSnapshot,
  type MiniLilacSkillSummary,
  type MiniLilacSteerRequest,
  type MiniLilacSteerResult,
  type MiniLilacStreamCursor,
  type MiniLilacTodoState,
  type MiniLilacUIMessage,
  type MiniLilacUndoInput,
  type MiniLilacUndoResult,
  type MiniLilacUpdateSessionBindingsInput,
  miniLilacCancelRequestSchema,
  miniLilacCancelResultSchema,
  miniLilacChatRequestExtrasSchema,
  miniLilacCompactRequestSchema,
  miniLilacCompactResultSchema,
  miniLilacInterruptQueuedSteeringRequestSchema,
  miniLilacInterruptQueuedSteeringResultSchema,
  miniLilacMessagesSchema,
  miniLilacModelsSchema,
  miniLilacProfilesSchema,
  miniLilacSessionResumeSchema,
  miniLilacSessionSnapshotSchema,
  miniLilacSessionsSchema,
  miniLilacSkillsSchema,
  miniLilacStreamCursorChunkSchema,
  miniLilacSteerRequestSchema,
  miniLilacSteerResultSchema,
  miniLilacTodoStateSchema,
  miniLilacUndoRequestSchema,
  miniLilacUndoResultSchema,
  miniLilacUpdateSessionBindingsRequestSchema,
} from "./protocol";

export type MiniLilacBearerTokenResolver = () =>
  | string
  | null
  | undefined
  | PromiseLike<string | null | undefined>;

export type MiniLilacReconnectEndpoint =
  | string
  | ((input: { baseUrl: string; chatId: string }) => string);

export type MiniLilacTransportOptions = Omit<MiniLilacChatRequestExtras, "clientCommandId"> & {
  baseUrl?: string;
  bearerToken?: MiniLilacBearerTokenResolver;
  reconnectEndpoint?: MiniLilacReconnectEndpoint;
  headers?: Record<string, string> | Headers;
  credentials?: RequestCredentials;
  fetch?: typeof globalThis.fetch;
  createClientCommandId?: () => string;
};

export type MiniLilacRequestOptions = {
  signal?: AbortSignal;
};

const sessionIdSchema = z.string().trim().min(1);

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, endpoint: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(endpoint)) return endpoint;
  const path = endpoint.replace(/^\/+/, "");
  return baseUrl.length === 0 ? `/${path}` : `${baseUrl}/${path}`;
}

function defaultClientCommandId(): string {
  return globalThis.crypto.randomUUID();
}

function setQueryParameter(url: string, name: string, value: string): string {
  const hashIndex = url.indexOf("#");
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  const path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  params.set(name, value);
  return `${path}?${params.toString()}${hash}`;
}

export class MiniLilacTransport implements ChatTransport<MiniLilacUIMessage> {
  private readonly baseUrl: string;
  private readonly bearerToken: MiniLilacBearerTokenResolver | undefined;
  private readonly credentials: RequestCredentials | undefined;
  private readonly fetch: typeof globalThis.fetch;
  private readonly headers: Record<string, string> | Headers | undefined;
  private readonly createClientCommandId: () => string;
  private readonly delegate: DefaultChatTransport<MiniLilacUIMessage>;
  private chatExtras: Omit<MiniLilacChatRequestExtras, "clientCommandId">;
  private bindingUpdateChain: Promise<void> = Promise.resolve();
  private readonly lastStreamCursor = new Map<string, MiniLilacStreamCursor>();
  private readonly streamGenerations = new Map<string, number>();

  constructor(options: MiniLilacTransportOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "/api/mini-lilac");
    this.bearerToken = options.bearerToken;
    this.credentials = options.credentials;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.headers = options.headers;
    this.createClientCommandId = options.createClientCommandId ?? defaultClientCommandId;

    this.chatExtras = miniLilacChatRequestExtrasSchema.parse({
      cwd: options.cwd,
      model: options.model,
      profile: options.profile,
      reasoning: options.reasoning,
    });

    this.delegate = new DefaultChatTransport<MiniLilacUIMessage>({
      api: joinUrl(this.baseUrl, "chat"),
      credentials: this.credentials,
      fetch: this.fetch,
      headers: () => this.createHeaders(false),
      prepareSendMessagesRequest: ({ id, messages, body, trigger, messageId }) => {
        const requestExtras = miniLilacChatRequestExtrasSchema.parse({
          ...this.chatExtras,
          ...body,
        });
        return {
          body: {
            ...requestExtras,
            id,
            messages,
            trigger,
            messageId,
            clientCommandId: requestExtras.clientCommandId ?? this.createClientCommandId(),
          },
        };
      },
      prepareReconnectToStreamRequest: ({ id }) => {
        const cursor = this.getLastStreamCursor(id);
        let api = this.resolveReconnectEndpoint(options.reconnectEndpoint, id);
        if (cursor !== undefined) {
          api = setQueryParameter(api, "runId", cursor.runId);
          api = setQueryParameter(api, "after", String(cursor.seq));
        }
        return { api };
      },
    });
  }

  async sendMessages(
    options: Parameters<ChatTransport<MiniLilacUIMessage>["sendMessages"]>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const generation = (this.streamGenerations.get(options.chatId) ?? 0) + 1;
    this.streamGenerations.set(options.chatId, generation);
    const stream = await this.delegate.sendMessages(options);
    this.lastStreamCursor.delete(options.chatId);
    return this.trackStream(options.chatId, generation, stream);
  }

  async reconnectToStream(
    options: Parameters<ChatTransport<MiniLilacUIMessage>["reconnectToStream"]>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const stream = await this.delegate.reconnectToStream(options);
    if (stream === null) return null;
    return this.trackStream(
      options.chatId,
      this.streamGenerations.get(options.chatId) ?? 0,
      stream,
    );
  }

  getLastStreamCursor(chatId: string): MiniLilacStreamCursor | undefined {
    return this.lastStreamCursor.get(chatId);
  }

  getSession(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacSessionSnapshot> {
    const id = sessionIdSchema.parse(sessionId);
    return this.requestJson(`sessions/${encodeURIComponent(id)}`, miniLilacSessionSnapshotSchema, {
      signal: options.signal,
    });
  }

  getSessionResume(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacSessionResume> {
    const id = sessionIdSchema.parse(sessionId);
    return this.requestJson(
      `sessions/${encodeURIComponent(id)}/resume`,
      miniLilacSessionResumeSchema,
      { signal: options.signal },
    );
  }

  setReconnectCursor(
    chatId: string,
    cursor: { readonly runId: string; readonly afterSeq: number } | null,
  ): void {
    if (cursor === null) {
      this.lastStreamCursor.delete(chatId);
      return;
    }
    this.lastStreamCursor.set(chatId, { runId: cursor.runId, seq: cursor.afterSeq });
  }

  listSessions(
    cwd: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacSessionSnapshot[]> {
    const normalizedCwd = z.string().trim().min(1).parse(cwd);
    return this.requestJson(
      `sessions?cwd=${encodeURIComponent(normalizedCwd)}`,
      miniLilacSessionsSchema,
      { signal: options.signal },
    );
  }

  getMessages(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacUIMessage[]> {
    const id = sessionIdSchema.parse(sessionId);
    return this.requestJson(
      `sessions/${encodeURIComponent(id)}/messages`,
      miniLilacMessagesSchema,
      {
        signal: options.signal,
      },
    );
  }

  async streamSession(
    sessionId: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const normalizedSessionId = sessionIdSchema.parse(sessionId);
    const headers = await this.createHeaders(false);
    const response = await this.fetch(
      joinUrl(this.baseUrl, `chat/${encodeURIComponent(normalizedSessionId)}/stream`),
      { credentials: this.credentials, headers, signal: options.signal },
    );
    if (response.status === 204) return null;
    if (!response.ok || response.body === null) {
      const detail = await response.text();
      throw new Error(
        detail.length > 0
          ? `MiniLilac request failed (${response.status}): ${detail}`
          : `MiniLilac request failed (${response.status})`,
      );
    }
    return parseJsonEventStream({
      stream: response.body,
      schema: uiMessageChunkSchema,
    }).pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (!chunk.success) throw chunk.error;
          controller.enqueue(chunk.value);
        },
      }),
    );
  }

  getTodos(sessionId: string, options: MiniLilacRequestOptions = {}): Promise<MiniLilacTodoState> {
    const id = sessionIdSchema.parse(sessionId);
    return this.requestJson(`sessions/${encodeURIComponent(id)}/todos`, miniLilacTodoStateSchema, {
      signal: options.signal,
    });
  }

  listModels(options: MiniLilacRequestOptions = {}): Promise<MiniLilacModelSummary[]> {
    return this.requestJson("models", miniLilacModelsSchema, { signal: options.signal });
  }

  listProfiles(options: MiniLilacRequestOptions = {}): Promise<MiniLilacProfileSummary[]> {
    return this.requestJson("profiles", miniLilacProfilesSchema, { signal: options.signal });
  }

  listSkills(
    cwd: string,
    profile?: string,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacSkillSummary[]> {
    const normalizedCwd = z.string().trim().min(1).parse(cwd);
    const params = new URLSearchParams({ cwd: normalizedCwd });
    if (profile !== undefined) params.set("profile", sessionIdSchema.parse(profile));
    return this.requestJson(`skills?${params.toString()}`, miniLilacSkillsSchema, {
      signal: options.signal,
    });
  }

  setSessionBindings(bindings: {
    readonly model?: string;
    readonly profile?: string;
    readonly reasoning?: MiniLilacChatRequestExtras["reasoning"];
  }): void {
    this.chatExtras = miniLilacChatRequestExtrasSchema.parse({
      ...this.chatExtras,
      ...bindings,
    });
  }

  updateSessionBindings(
    request: MiniLilacUpdateSessionBindingsInput,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacSessionSnapshot> {
    const operation = this.bindingUpdateChain.then(
      () => this.performSessionBindingUpdate(request, options),
      () => this.performSessionBindingUpdate(request, options),
    );
    this.bindingUpdateChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  steer(
    request: MiniLilacSteerRequest,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacSteerResult> {
    const payload = miniLilacSteerRequestSchema.parse({
      ...request,
      clientCommandId: request.clientCommandId ?? this.createClientCommandId(),
    });
    return this.postControl(
      payload.sessionId,
      "steer",
      payload,
      miniLilacSteerResultSchema,
      options,
    );
  }

  interruptQueuedSteering(
    request: MiniLilacInterruptQueuedSteeringInput,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacInterruptQueuedSteeringResult> {
    const payload = miniLilacInterruptQueuedSteeringRequestSchema.parse({
      ...request,
      clientCommandId: request.clientCommandId ?? this.createClientCommandId(),
    });
    return this.postControl(
      payload.sessionId,
      "interrupt-queued-steering",
      payload,
      miniLilacInterruptQueuedSteeringResultSchema,
      options,
    );
  }

  cancel(
    request: MiniLilacCancelRequest,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacCancelResult> {
    const payload = miniLilacCancelRequestSchema.parse({
      ...request,
      clientCommandId: request.clientCommandId ?? this.createClientCommandId(),
    });
    return this.postControl(
      payload.sessionId,
      "cancel",
      payload,
      miniLilacCancelResultSchema,
      options,
    );
  }

  undo(
    request: MiniLilacUndoInput,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacUndoResult> {
    const payload = miniLilacUndoRequestSchema.parse({
      ...request,
      clientCommandId: request.clientCommandId ?? this.createClientCommandId(),
    });
    return this.postControl(payload.sessionId, "undo", payload, miniLilacUndoResultSchema, options);
  }

  compact(
    request: MiniLilacCompactInput,
    options: MiniLilacRequestOptions = {},
  ): Promise<MiniLilacCompactResult> {
    const payload = miniLilacCompactRequestSchema.parse({
      ...request,
      clientCommandId: request.clientCommandId ?? this.createClientCommandId(),
    });
    return this.postControl(
      payload.sessionId,
      "compact",
      payload,
      miniLilacCompactResultSchema,
      options,
    );
  }

  private async performSessionBindingUpdate(
    request: MiniLilacUpdateSessionBindingsInput,
    options: MiniLilacRequestOptions,
  ): Promise<MiniLilacSessionSnapshot> {
    const payload = miniLilacUpdateSessionBindingsRequestSchema.parse({
      ...request,
      clientCommandId: request.clientCommandId ?? this.createClientCommandId(),
    });
    const snapshot = await this.postControl(
      payload.sessionId,
      "bindings",
      payload,
      miniLilacSessionSnapshotSchema,
      options,
    );
    this.setSessionBindings({
      model: snapshot.model ?? undefined,
      profile: snapshot.profile ?? undefined,
      reasoning: snapshot.reasoning ?? undefined,
    });
    return snapshot;
  }

  private resolveReconnectEndpoint(
    endpoint: MiniLilacReconnectEndpoint | undefined,
    chatId: string,
  ): string {
    if (typeof endpoint === "function") return endpoint({ baseUrl: this.baseUrl, chatId });
    if (endpoint !== undefined) {
      if (endpoint.startsWith("/") || /^[a-z][a-z\d+.-]*:\/\//i.test(endpoint)) return endpoint;
      return joinUrl(this.baseUrl, endpoint);
    }
    return joinUrl(this.baseUrl, `chat/${encodeURIComponent(chatId)}/stream`);
  }

  private trackStream(
    chatId: string,
    generation: number,
    stream: ReadableStream<UIMessageChunk>,
  ): ReadableStream<UIMessageChunk> {
    let pendingCursor: MiniLilacStreamCursor | undefined;

    return stream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform: (chunk, controller) => {
          const cursor = miniLilacStreamCursorChunkSchema.safeParse(chunk);
          const isCurrentGeneration = (this.streamGenerations.get(chatId) ?? 0) === generation;

          if (!isCurrentGeneration) {
            pendingCursor = undefined;
          } else if (cursor.success) {
            pendingCursor = cursor.data.data;
          }

          controller.enqueue(chunk);

          if (isCurrentGeneration && !cursor.success && pendingCursor !== undefined) {
            this.lastStreamCursor.set(chatId, pendingCursor);
            pendingCursor = undefined;
          }
        },
      }),
    );
  }

  private async createHeaders(json: boolean): Promise<Headers> {
    const headers = new Headers(this.headers);
    const token = await this.bearerToken?.();
    if (token !== null && token !== undefined) headers.set("Authorization", `Bearer ${token}`);
    if (json) headers.set("Content-Type", "application/json");
    return headers;
  }

  private postControl<T>(
    sessionId: string,
    action: string,
    body: object,
    schema: z.ZodType<T>,
    options: MiniLilacRequestOptions,
  ): Promise<T> {
    return this.requestJson(`sessions/${encodeURIComponent(sessionId)}/${action}`, schema, {
      method: "POST",
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  private async requestJson<T>(
    endpoint: string,
    schema: z.ZodType<T>,
    init: RequestInit,
  ): Promise<T> {
    const headers = await this.createHeaders(init.body !== undefined);
    const response = await this.fetch(joinUrl(this.baseUrl, endpoint), {
      ...init,
      credentials: this.credentials,
      headers,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        detail.length > 0
          ? `MiniLilac request failed (${response.status}): ${detail}`
          : `MiniLilac request failed (${response.status})`,
      );
    }

    const value: unknown = await response.json();
    return schema.parse(value);
  }
}
