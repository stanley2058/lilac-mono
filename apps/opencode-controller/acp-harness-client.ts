import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type ListSessionsResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

import type { PermissionBehavior, PermissionCounters, ResolvedHarness } from "./types.ts";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function choosePermissionOutcome(
  behavior: PermissionBehavior,
  request: RequestPermissionRequest,
): RequestPermissionResponse["outcome"] {
  const pick = (...kinds: readonly string[]) =>
    request.options.find((option) => kinds.includes(option.kind));

  const preferred =
    behavior === "reject"
      ? pick("reject_once", "reject_always")
      : behavior === "once"
        ? pick("allow_once", "allow_always", "reject_once", "reject_always")
        : pick("allow_always", "allow_once", "reject_once", "reject_always");

  if (!preferred) {
    return { outcome: "cancelled" };
  }

  return {
    outcome: "selected",
    optionId: preferred.optionId,
  };
}

class ControllerClient implements Client {
  constructor(
    private readonly permissionBehavior: PermissionBehavior,
    private readonly counters: PermissionCounters,
    private readonly onUpdate?: (notification: SessionNotification) => Promise<void> | void,
  ) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const outcome = choosePermissionOutcome(this.permissionBehavior, params);
    if (outcome.outcome === "cancelled") {
      this.counters.permissionsCancelled++;
    } else if (
      params.options.some(
        (option) => option.optionId === outcome.optionId && option.kind.startsWith("reject"),
      )
    ) {
      this.counters.permissionsRejected++;
    } else {
      this.counters.permissionsApproved++;
    }
    return { outcome };
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    await this.onUpdate?.(params);
  }
}

export class AcpHarnessClient {
  private constructor(
    readonly harness: ResolvedHarness,
    readonly initializeResponse: InitializeResponse,
    private readonly child: ChildProcess,
    private readonly connection: ClientSideConnection,
    private readonly stderrBuffer: { value: string },
  ) {}

  static async connect(params: {
    harness: ResolvedHarness;
    version: string;
    permissionBehavior: PermissionBehavior;
    counters: PermissionCounters;
    onUpdate?: (notification: SessionNotification) => Promise<void> | void;
  }): Promise<AcpHarnessClient> {
    const child = spawn(params.harness.command, [...params.harness.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const stderrBuffer = { value: "" };
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrBuffer.value = `${stderrBuffer.value}${text}`.slice(-4000);
    });

    const input = Writable.toWeb(child.stdin!);
    const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);
    const client = new ControllerClient(
      params.permissionBehavior,
      params.counters,
      params.onUpdate,
    );
    const connection = new ClientSideConnection(() => client, stream);

    try {
      const initializeResponse = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: {
          name: "lilac-acp",
          title: "Lilac ACP",
          version: params.version,
        },
      });
      return new AcpHarnessClient(
        params.harness,
        initializeResponse,
        child,
        connection,
        stderrBuffer,
      );
    } catch (error) {
      child.kill();
      const stderr = stderrBuffer.value.trim();
      const details = stderr.length > 0 ? ` stderr=${stderr}` : "";
      throw new Error(
        `Failed to initialize harness '${params.harness.descriptor.id}': ${errorMessage(error)}.${details}`,
      );
    }
  }

  capabilities(): string[] {
    const agentCapabilities = this.initializeResponse.agentCapabilities;
    const values: string[] = [];
    if (agentCapabilities?.sessionCapabilities?.list) values.push("listSessions");
    if (agentCapabilities?.loadSession) values.push("loadSession");
    if (agentCapabilities?.sessionCapabilities?.resume) values.push("resumeSession");
    return values;
  }

  authHint(): string | undefined {
    const authMethods = this.initializeResponse.authMethods;
    if (!authMethods || authMethods.length === 0) return undefined;
    const first = authMethods[0];
    return (
      first?.description ?? `Authenticate with ${first?.name ?? this.harness.descriptor.title}.`
    );
  }

  async listSessions(cwd: string): Promise<ListSessionsResponse["sessions"]> {
    if (!this.initializeResponse.agentCapabilities?.sessionCapabilities?.list) {
      throw new Error(`Harness '${this.harness.descriptor.id}' does not support session listing.`);
    }

    const sessions = [] as ListSessionsResponse["sessions"];
    let cursor: string | null | undefined;
    do {
      const response = await this.connection.listSessions({
        cwd,
        ...(cursor ? { cursor } : {}),
      });
      sessions.push(...response.sessions);
      cursor = response.nextCursor;
    } while (cursor);

    return sessions;
  }

  async createSession(cwd: string): Promise<NewSessionResponse> {
    return this.connection.newSession({ cwd, mcpServers: [] });
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    if (this.initializeResponse.agentCapabilities?.loadSession) {
      await this.connection.loadSession({ sessionId, cwd, mcpServers: [] });
      return;
    }

    if (this.initializeResponse.agentCapabilities?.sessionCapabilities?.resume) {
      await this.connection.unstable_resumeSession({ sessionId, cwd });
      return;
    }

    throw new Error(`Harness '${this.harness.descriptor.id}' does not support loading sessions.`);
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.connection.setSessionMode({ sessionId, modeId });
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.connection.unstable_setSessionModel({ sessionId, modelId });
  }

  async prompt(sessionId: string, text: string, messageId: string): Promise<PromptResponse> {
    return this.connection.prompt({
      sessionId,
      messageId,
      prompt: [{ type: "text", text }],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.connection.cancel({ sessionId });
  }

  async close(): Promise<void> {
    try {
      if (this.initializeResponse.agentCapabilities?.sessionCapabilities?.stop) {
        // No session scope available here; worker handles session stop lifecycle separately.
      }
      this.child.kill();
      await Promise.race([
        this.connection.closed,
        new Promise<void>((resolve) => setTimeout(resolve, 200)),
      ]);
    } catch {
      // Ignore shutdown failures.
    }
  }

  stderr(): string {
    return this.stderrBuffer.value.trim();
  }
}

export function isAuthRequiredError(error: unknown): boolean {
  return error instanceof RequestError && error.code === -32004;
}

export function isCancelledStopReason(stopReason: PromptResponse["stopReason"]): boolean {
  return stopReason === "cancelled";
}

export function extractModeIds(
  response: SessionUpdate | NewSessionResponse | InitializeResponse,
): string[] {
  if ("modes" in response && response.modes) {
    return response.modes.availableModes.map((mode) => mode.id);
  }
  return [];
}
