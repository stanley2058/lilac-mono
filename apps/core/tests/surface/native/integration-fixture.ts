import type { JobService } from "../../../src/jobs/job-service";
import { DurableWorkflowStore } from "../../../src/workflow/durable-workflow-store";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { nativeContract } from "@stanley2058/lilac-client-protocol";
import { createLilacBus, lilacEventTypes } from "@stanley2058/lilac-event-bus";
import { createMemoryBlobStore } from "@stanley2058/lilac-blob-storage";
import { parseCoreConfigV2ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { Result, type Result as ResultType } from "better-result";
import { createInMemoryDeliveryBus } from "../../helpers/in-memory-delivery-bus";
import { CustomCommandManager } from "../../../src/custom-commands/manager";
import { CoreResourceService, ResourceOriginAdapterRegistry } from "../../../src/resource";
import { SqliteTranscriptStore } from "../../../src/transcript/transcript-store";
import { SqliteAgentRunJournal } from "../../../src/surface/bridge/agent-run-journal";
import {
  startBusAgentRunner,
  resolveAgentRunModelResult,
} from "../../../src/surface/bridge/bus-agent-runner";
import { getBuiltinSurfaceProtocol } from "../../../src/surface/builtin-surface-protocols";
import type { ResolvedSurfaceProtocol } from "../../../src/surface/runtime-descriptor";
import {
  RequestDeliveryCoordinator,
  SqliteRequestDeliveryStore,
  coreRequestDeliveryCodecs,
  createCoreRequestDeliveryAdmission,
  createDurableCoreRequestBus,
  type RequestDeliveryPublisher,
  type CorePreparedRequestEnvelope,
} from "../../../src/surface/bridge/request-delivery";
import { createNativeLocalAuthenticator } from "../../../src/surface/native/auth-local";
import {
  authFailure,
  sameNativePrincipal,
  type NativeAuthenticator,
  type NativeAuthContext,
  type NativeLogin,
  type NativeAuthError,
} from "../../../src/surface/native/auth";
import {
  openNativeInstallation,
  type NativeInstallationSecrets,
} from "../../../src/surface/native/installation";
import {
  createNativeRuntime,
  type NativeRuntimeOptions,
} from "../../../src/surface/native/runtime";
import type { CoreToolPluginManager, BuiltLevel1Toolset } from "../../../src/plugins";
import { QuestionService } from "../../../src/question/question-service";
import { SqliteQuestionStore } from "../../../src/question/question-store";
import { nativeSurfaceProtocol } from "../../../src/surface/native/native-protocol";
import { createQuestionTool } from "../../../src/tools/question";

export function integrationValue<T, E>(result: ResultType<T, E>): T {
  return result.match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
}

export function nativeFixtureTextResponse(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: text },
        { type: "text-end" as const, id: "text" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
        },
      ],
    }),
  };
}

function fixturePluginManager(questions?: QuestionService): CoreToolPluginManager {
  const toolset: BuiltLevel1Toolset = {
    tools: questions ? { question: createQuestionTool(questions) } : {},
    specs: new Map(),
    contributionInfo: new Map(),
    directToolNames: new Set(questions ? ["question"] : []),
    catalog: [],
    catalogMetadata: {},
    genericOutputNormalizerBypassTools: new Set(),
    aggregateOutputBudgetExemptTools: new Set(),
    release: async () => Result.ok(undefined),
  };
  return {
    init: async () => Result.ok(),
    destroy: async () => Result.ok(),
    reload: async () => Result.ok(),
    ensureFresh: async () => Result.ok(),
    getStatuses: () => [],
    getLevel2Tools: () => [],
    getLevel2ContributionInfo: () => new Map(),
    buildLevel1ToolsetResult: async () => Result.ok(toolset),
  };
}

function fixtureQuestions(
  store: SqliteQuestionStore,
  runtime: Awaited<ReturnType<typeof createNativeRuntime>> extends ResultType<infer T, unknown>
    ? T
    : never,
) {
  const question = runtime.descriptor.createQuestion?.(runtime.descriptor.adapter);
  if (!question) throw new Error("Native question port is unavailable");
  const resolved = { platform: "native" as const, protocol: nativeSurfaceProtocol, question };
  return new QuestionService({
    store,
    surfaces: {
      entries: () => [resolved],
      resolve: (platform) => (platform === "native" ? resolved : null),
    },
    logger: { warn: () => {} },
  });
}

export async function createNativeIntegrationFixture(
  options: {
    mcpRegistry?: NativeRuntimeOptions["mcpRegistry"];
    port?: number;
    operatorTokenSha256?: string;
    password?: string;
    allowedOrigins?: string[];
    installationSecrets?: NativeInstallationSecrets;
    publishableKey?: string;
    model?: MockLanguageModelV4;
    /** Runs the shared question service and offers the question tool to the model. */
    questions?: boolean;
    jobs?: JobService;
    seed?: (
      store: import("../../../src/surface/native/store").NativeStore,
      transcript: SqliteTranscriptStore,
      database: import("bun:sqlite").Database,
    ) => void | Promise<void>;
    additionalLocalUsers?: readonly {
      userId: string;
      username: string;
      password: string;
      sessionLifetimeSeconds?: number;
    }[];
    prepare?: (input: {
      workspaceRoot: string;
      dataDir: string;
      config: CoreConfig;
    }) => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "lilac-native-integration-"));
  const dataDir = path.join(root, "data");
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const config = parseCoreConfigV2ToUniversal({});
  config.models.main = { model: "openai/native-fixture" };
  config.surface.native.enabled = true;
  config.surface.native.installationId = "native-integration";
  config.surface.native.host = "127.0.0.1";
  config.surface.native.port = options.port ?? 0;
  config.surface.native.publicUrl = `http://127.0.0.1:${options.port ?? 8789}`;
  config.surface.native.allowedOrigins = options.allowedOrigins ?? ["http://127.0.0.1:8789"];
  config.surface.native.auth.provider = "local";
  config.surface.native.auth.ownerId = "owner";
  config.conversation.thread.summarization.enabled = false;
  await options.prepare?.({ workspaceRoot, dataDir, config });
  integrationValue(resolveAgentRunModelResult({ cfg: config, runProfile: "primary" }));
  await writeFile(path.join(dataDir, "core-config.yaml"), "configVersion: 2\n");
  await writeFile(path.join(dataDir, "mcp-config.yaml"), "configVersion: 1\nservers: {}\n");
  const username = "owner";
  const password = options.password ?? "native-fixture-password";
  const installation = integrationValue(
    await openNativeInstallation({
      config: config.surface.native,
      dataDir,
      secrets: options.installationSecrets ?? {
        localUsername: username,
        localPasswordHash: await Bun.password.hash(password, {
          algorithm: "argon2id",
          memoryCost: 4096,
          timeCost: 1,
        }),
        sessionSecret: "native-integration-session-key-0123456789",
      },
    }),
  );
  const store = installation.store;
  if (options.additionalLocalUsers?.length) {
    if (config.surface.native.auth.provider !== "local")
      throw new Error("Additional fixture accounts require the local provider");
    const originalAuth = installation.auth;
    const originalLogin = installation.login;
    if (!originalLogin) throw new Error("Local fixture login is unavailable");
    const authenticators = new Map<string, NativeAuthenticator>([["owner", originalAuth]]);
    const logins = new Map<
      string,
      (request: Request, clientKey: string) => Promise<Result<NativeLogin, NativeAuthError>>
    >([[username, originalLogin]]);
    for (const user of options.additionalLocalUsers) {
      if (authenticators.has(user.userId) || logins.has(user.username))
        throw new Error("Duplicate browser fixture identity");
      store
        .upsertUser({
          id: user.userId,
          providerId: user.username,
          displayName: user.username,
          role: "participant",
          toolMode: "restricted",
        })
        .unwrap();
      const auth = createNativeLocalAuthenticator({
        ownerUserId: user.userId,
        username: user.username,
        passwordHash: await Bun.password.hash(user.password, {
          algorithm: "argon2id",
          memoryCost: 4096,
          timeCost: 1,
        }),
        signingKey: crypto.getRandomValues(new Uint8Array(32)),
        installationId: config.surface.native.installationId!,
        allowedOrigins: config.surface.native.allowedOrigins,
        sessionLifetimeSeconds: user.sessionLifetimeSeconds,
      });
      authenticators.set(user.userId, auth);
      logins.set(user.username, auth.login);
    }
    const authenticate = async (request: Request, context?: NativeAuthContext) => {
      for (const auth of authenticators.values()) {
        const result = await auth.authenticate(request, context);
        if (result.isOk()) return result;
      }
      return Result.err(authFailure("unauthorized", "Fixture session is invalid"));
    };
    installation.auth = {
      authenticate,
      checkSession: (principal) =>
        authenticators.get(principal.userId)?.checkSession(principal) ??
        Result.err(authFailure("unauthorized", "Fixture identity is unavailable")),
      reauthenticate: async (principal, request) =>
        (await authenticate(request, { socket: true })).andThen((fresh) =>
          sameNativePrincipal(principal, fresh),
        ),
      logout: async (request) => {
        const principal = await authenticate(request);
        if (principal.isErr()) return Result.err(principal.error);
        return await authenticators.get(principal.value.userId)!.logout(request);
      },
    };
    installation.login = (request, clientKey) => {
      const header = request.headers.get("authorization") ?? "";
      const name = header.startsWith("Basic ")
        ? Buffer.from(header.slice(6), "base64").toString("utf8").split(":")[0]
        : undefined;
      return (logins.get(name ?? "") ?? originalLogin)(request, clientKey);
    };
  }

  const blobs = integrationValue(await createMemoryBlobStore());
  const transcript = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
  const resourceAccess = new CoreResourceService({
    store: transcript,
    blobStore: blobs,
    originAdapters: new ResourceOriginAdapterRegistry([]),
  });
  const requestDb = path.join(dataDir, "request-delivery.db");
  const deliveryStore = new SqliteRequestDeliveryStore({
    dbPath: requestDb,
    codecs: coreRequestDeliveryCodecs,
  });
  const coordinator = new RequestDeliveryCoordinator({
    store: deliveryStore,
    blobStore: blobs,
    admission: createCoreRequestDeliveryAdmission(blobs),
  });
  const transportBus = createLilacBus(createInMemoryDeliveryBus());
  const claims = new Map<string, string>();
  const publicationReceipts = new Map<string, string>();
  const publisher: RequestDeliveryPublisher<CorePreparedRequestEnvelope> = {
    acquire: async ({ requestDeliveryId }) => {
      if (claims.has(requestDeliveryId)) return Result.ok({ status: "contended" });
      const token = crypto.randomUUID();
      claims.set(requestDeliveryId, token);
      return Result.ok({ status: "acquired", claim: { requestDeliveryId, token } });
    },
    publish: async ({ requestDeliveryId, envelope, claim }) => {
      if (claims.get(requestDeliveryId) !== claim.token)
        return Result.err(new Error("Fixture publication claim fenced"));
      const previous = publicationReceipts.get(requestDeliveryId);
      if (previous) return Result.ok({ streamId: previous });
      const result = await transportBus.publish(lilacEventTypes.CmdRequestMessage, envelope.data, {
        headers: envelope.headers,
      });
      return result.map(({ id }) => {
        publicationReceipts.set(requestDeliveryId, id);
        return { streamId: id };
      });
    },
    confirm: async ({ claim, streamId }) => {
      if (claims.get(claim.requestDeliveryId) !== claim.token) return Result.ok("fenced");
      if (publicationReceipts.get(claim.requestDeliveryId) !== streamId)
        return Result.ok("mismatch");
      claims.delete(claim.requestDeliveryId);
      return Result.ok("confirmed");
    },
    abandon: async ({ claim }) => {
      claims.delete(claim.requestDeliveryId);
      return Result.ok("abandoned");
    },
    classifyFailure: (error) => ({ certainty: "ambiguous", code: error.name }),
  };
  const bus = createDurableCoreRequestBus({ transportBus, coordinator, publisher });
  const journal = new SqliteAgentRunJournal({ dbPath: requestDb });
  const customCommands = new CustomCommandManager(dataDir);
  integrationValue(await customCommands.init());
  const subagentWorkflows = new DurableWorkflowStore(":memory:");
  let runner: Awaited<ReturnType<typeof startBusAgentRunner>> | undefined;
  const fatalErrors: Error[] = [];
  const warnings: { message: string; error: Error }[] = [];
  const runtime = integrationValue(
    await createNativeRuntime({
      ...(options.jobs ? { jobs: options.jobs } : {}),
      generateTitle: async () =>
        Result.ok({ title: "Fixture conversation", needsRefinement: false }),
      installation,
      publishableKey: options.publishableKey,
      bus,
      blobs,
      transcript,
      resourceAccess,
      getConfig: () => config,
      dataDir,
      workspaceRoot,
      denyPaths: [],
      subscriptionPrefix: "native-integration",
      customCommands,
      mcpRegistry: options.mcpRegistry ?? {
        reload: async () => Result.ok([]),
        getCatalogServers: () => [],
        getTools: () => [],
      },
      adapters: { registeredPlatforms: () => [], resolve: () => null },
      conversationThreads: () => undefined,
      runner: () => runner,
      workflows: subagentWorkflows,
      deliveryState: (id) =>
        deliveryStore.load(id).map((record) => {
          if (!record) return "missing" as const;
          if (record.state !== "terminal") return "owned" as const;
          if (record.outcome.kind === "completed") return "completed" as const;
          if (record.outcome.kind === "cancelled") return "cancelled" as const;
          if (record.outcome.kind === "abandoned") return "abandoned" as const;
          return "failed" as const;
        }),
      operatorTokenSha256: options.operatorTokenSha256,
      reportFatalError: (error) => {
        fatalErrors.push(error);
      },
      warn: (message, error) => {
        warnings.push({ message, error });
      },
    }),
  );
  integrationValue(await runtime.startOutput());
  const questionStore = options.questions
    ? new SqliteQuestionStore({ dbPath: requestDb })
    : undefined;
  const questions = questionStore ? fixtureQuestions(questionStore, runtime) : undefined;
  if (questions) integrationValue(await questions.start());
  const pluginManager = fixturePluginManager(questions);
  runner = await startBusAgentRunner({
    questions,
    ...(options.jobs ? { jobs: options.jobs } : {}),
    bus,
    blobStore: blobs,
    config,
    cwd: workspaceRoot,
    subscriptionId: "native-integration-runner",
    startPaused: true,
    pluginManager,
    customCommands,
    transcriptStore: transcript,
    requestDelivery: coordinator,
    agentRunJournal: journal,
    nativeExecution: runtime.execution.runnerLifecycle,
    createNativeOutput: runtime.createOutput,
    nativeResourceAccess: runtime.scopedResources,
    nativeConversationThreads: runtime.scopedThreads,
    surfaceProtocolResolver: {
      resolve: (platform) => {
        const protocol = getBuiltinSurfaceProtocol(platform);
        return protocol
          ? ({ platform: protocol.platform, protocol } as ResolvedSurfaceProtocol)
          : null;
      },
    },
    reportFatalPanic: (panic) => {
      fatalErrors.push(panic);
    },
    issueControlCapability: () => ({
      capability: "native-integration-capability",
      principal: null,
    }),
    createAgent: (agentOptions) =>
      new AiSdkPiAgent({
        ...agentOptions,
        model:
          options.model ??
          new MockLanguageModelV4({
            modelId: "native-fixture",
            doStream: async () =>
              nativeFixtureTextResponse("Fixture response.\n\nReady for the next message."),
          }),
      }),
  });
  await options.seed?.(store, transcript, installation.database);
  integrationValue(await runtime.recover());
  await questions?.finishStartupRecovery();
  runner.activate();
  const address = integrationValue(runtime.startIngress());
  const url = address.url;
  let loginData = { token: "" };
  if (config.surface.native.auth.provider === "local") {
    const login = await fetch(new URL("api/auth/login", url), {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${username}:${password}`)}` },
    });
    if (!login.ok) throw new Error(`Native fixture login failed: ${login.status}`);
    loginData = (await login.json()) as { token: string };
  }
  const sockets = new Set<WebSocket>();
  async function loginAs(loginUsername: string, loginPassword: string): Promise<string> {
    const response = await fetch(new URL("api/auth/login", url), {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${loginUsername}:${loginPassword}`)}` },
    });
    if (!response.ok) throw new Error(`Fixture login failed: ${response.status}`);
    const body = (await response.json()) as { token: string };
    return body.token;
  }
  function connect(token = loginData.token) {
    const endpoint = new URL("api/socket", url);
    endpoint.protocol = "ws:";
    const socket = new (WebSocket as unknown as {
      new (url: URL, options: { headers: Record<string, string> }): WebSocket;
    })(endpoint, { headers: { authorization: `Bearer ${token}` } });
    sockets.add(socket);
    const traffic = { sent: 0, received: 0 };
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      if (typeof data !== "string") throw new Error("Native RPC must send JSON text frames");
      const bytes = new TextEncoder().encode(data).byteLength;
      traffic.sent += bytes + (bytes < 126 ? 6 : 8);
      return send(data);
    };
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string")
        throw new Error("Native RPC must return JSON text frames");
      const bytes = new TextEncoder().encode(event.data).byteLength;
      traffic.received += bytes + (bytes < 126 ? 2 : 4);
    });
    const client: ContractRouterClient<typeof nativeContract> = createORPCClient(
      new RPCLink({ websocket: socket }),
    );
    return {
      socket,
      client,
      traffic,
      resetTraffic: () => {
        traffic.sent = 0;
        traffic.received = 0;
      },
    };
  }
  async function close() {
    for (const socket of sockets) socket.close();
    await runtime.stopIngress();
    await runner?.stop();
    await questions?.stop();
    questionStore?.close();
    subagentWorkflows.close();
    await runtime.stopOutput();
    await pluginManager.destroy();
    await resourceAccess.close();
    await bus.close();
    journal.close();
    deliveryStore.close();
    transcript.close();
    installation.database.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1000 });
    await rm(root, { recursive: true, force: true });
  }
  return {
    url,
    token: loginData.token,
    username,
    password,
    config,
    dataDir,
    workspaceRoot,
    store,
    workflows: subagentWorkflows,
    runtime,
    runner,
    blobs,
    bus,
    transcript,
    journal,
    connect,
    loginAs,
    close,
    fatalErrors,
    warnings,
  };
}
