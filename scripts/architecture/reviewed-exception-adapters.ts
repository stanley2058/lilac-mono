import type { ExceptionAdapter } from "./manifest.ts";

export const REVIEWED_EXCEPTION_ADAPTERS: Readonly<Record<string, readonly ExceptionAdapter[]>> = {
  "apps/tui": [
    {
      identity: { module: "src/fatal.ts", exportName: "rethrowTuiDefect" },
      category: "defect-supervisor",
      externalApi: { package: "@opentui/core", exportName: "terminal application host" },
      direction: "signal-host",
      reason:
        "Preserves a captured terminal application defect after controller failure or application cleanup policy is resolved.",
    },
    {
      identity: { module: "src/session.ts", exportName: "nativeTuiHttpFailure" },
      category: "result-to-framework",
      externalApi: { package: "@orpc/client", exportName: "ORPCError" },
      direction: "signal-host",
      reason:
        "Maps terminal bootstrap and upload Result failures to the shared client's asynchronous transport error contract after Result policy is resolved.",
    },
  ],
  "apps/web": [
    {
      identity: { module: "src/queries.ts", exportName: "queryNativeRPC" },
      category: "compatibility",
      externalApi: { package: "@orpc/client", exportName: "ORPCError" },
      direction: "signal-host",
      reason:
        "Reports a disconnected native client through TanStack Query's rejected Promise contract while resolving the current RPC at execution time.",
    },
    {
      identity: { module: "src/cache.ts", exportName: "signalWebCacheFailure" },
      category: "result-to-framework",
      externalApi: { package: "@stanley2058/lilac-client", exportName: "NativeCache" },
      direction: "signal-host",
      reason:
        "Reports aborted IndexedDB commits through the shared cache Promise contract so the client cannot advance its checkpoint after a failed transaction.",
    },
    {
      identity: { module: "src/cache.ts", exportName: "rejectWebCacheRequest" },
      category: "compatibility",
      externalApi: { package: "global", exportName: "IndexedDB request Promise rejection" },
      direction: "signal-host",
      reason:
        "Adapts IndexedDB request error and blocked-open events to rejected Promises consumed by the local cache fallback capture boundary.",
    },
    {
      identity: { module: "src/http.ts", exportName: "nativeWebHttpFailure" },
      category: "result-to-framework",
      externalApi: { package: "@orpc/client", exportName: "ORPCError" },
      direction: "signal-host",
      reason:
        "Maps HTTP bootstrap and upload Result failures to the shared client's asynchronous transport error contract after Result policy is resolved.",
    },
  ],
  "apps/installer": [
    {
      identity: { module: "src/prompt.ts", exportName: "resolvePromptValue" },
      category: "compatibility",
      externalApi: { package: "@clack/prompts", exportName: "isCancel" },
      direction: "signal-host",
      reason:
        "Translates Clack's cancellation sentinel to AbortError so the installer unwinds through terminal and staging cleanup before returning exit status 130.",
    },
    {
      identity: { module: "src/failure.ts", exportName: "withInstallerCleanup" },
      category: "compatibility",
      externalApi: { package: "global", exportName: "Promise rejection" },
      direction: "signal-host",
      reason:
        "Preserves operation or cleanup failure identity after cleanup has settled, with Panic taking precedence over cancellation.",
    },
    {
      identity: { module: "src/wizard.ts", exportName: "runWizard" },
      category: "compatibility",
      externalApi: { package: "global", exportName: "Promise rejection" },
      direction: "signal-host",
      reason:
        "Forwards unexpected setup defects to the sanitized installer host after closing the terminal, while returning recognized cancellation as an exit result.",
    },
  ],
  "apps/core": [
    {
      identity: {
        module: "src/surface/native/gateway.ts",
        exportName: "rethrowNativeGatewayFailure",
      },
      category: "defect-supervisor",
      externalApi: { package: "@orpc/server", exportName: "AsyncIteratorClass" },
      direction: "signal-host",
      reason:
        "Preserves the original streamed iterator failure after reporting it to the runtime supervisor, before oRPC serializes its terminal error event.",
    },
    {
      identity: {
        module: "src/surface/native/runtime.ts",
        exportName: "nativeRuntimeFailureToHost",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "native runtime lifecycle host",
      },
      direction: "signal-host",
      reason:
        "Signals failed durable output initialization or managed consumer shutdown through the existing runner and runtime lifecycle rejection contracts after Result policy is resolved.",
    },
    {
      identity: { module: "src/surface/native/search.ts", exportName: "nativeSearchFailureToHost" },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "ConversationThreadToolService",
      },
      direction: "signal-host",
      reason:
        "Signals a scoped native search Result failure through the existing conversation tool service rejection contract after Result policy is resolved.",
    },
    {
      identity: {
        module: "src/surface/native/resources.ts",
        exportName: "signalNativeResourceStreamFailure",
      },
      category: "result-to-framework",
      externalApi: { package: "global", exportName: "TransformStreamDefaultController.error" },
      direction: "signal-host",
      reason:
        "Signals verified upload size failures and revoked resource access to the stream host so it stops transferring bytes.",
    },
    {
      identity: { module: "src/surface/native/rpc.ts", exportName: "nativeRpcFailure" },
      category: "result-to-framework",
      externalApi: { package: "@orpc/server", exportName: "ORPCError" },
      direction: "signal-host",
      reason:
        "Maps a native service Result failure to the oRPC host error contract after the Result callback returns, preserving expected failure classification.",
    },
    {
      identity: {
        module: "src/conversation/thread-service.ts",
        exportName:
          "createConversationThreadToolService.resolvePersistenceOperation.err.<callback>",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "ConversationThreadToolService",
      },
      direction: "signal-host",
      reason: "Signals a failed persisted-summary Result through the tool host exception contract.",
    },
    {
      identity: {
        module: "src/workflow/workflow-live-parent-bridge.ts",
        exportName: "WorkflowLiveParentBridge.registerParent",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "live-parent lifecycle host",
      },
      direction: "signal-host",
      reason:
        "Adapts live-parent invariant or publication failure to the established lifecycle rejection contract.",
    },
    {
      identity: {
        module: "src/workflow/workflow-live-parent-bridge.ts",
        exportName: "WorkflowLiveParentBridge.registerParent.then.<callback@1>",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "live-parent lifecycle host",
      },
      direction: "signal-host",
      reason:
        "Rejects readiness with the selected child preparation failure after every preparation settles.",
    },
    {
      identity: {
        module: "src/workflow/workflow-live-parent-bridge.ts",
        exportName: "WorkflowLiveParentBridge.registerParent.catch.<callback@1>",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "live-parent lifecycle host",
      },
      direction: "signal-host",
      reason:
        "Releases failed live-parent registration before preserving the original readiness rejection and Panic precedence.",
    },
    {
      identity: {
        module: "src/mcp/error-format.ts",
        exportName: "rethrowPanic",
      },
      category: "defect-supervisor",
      externalApi: {
        package: "better-result",
        exportName: "Panic.is",
      },
      direction: "observe-panic",
      reason: "Narrow helper propagates Panic without exempting its callers' ordinary throws.",
    },
    {
      identity: {
        module: "src/mcp/modern-result-validation.ts",
        exportName: "preserveTransportPanic",
      },
      category: "defect-supervisor",
      externalApi: {
        package: "better-result",
        exportName: "Panic.is",
      },
      direction: "observe-panic",
      reason:
        "Preserves exact Panic identity while modern discovery owns ordinary transport failures.",
    },
    {
      identity: {
        module: "src/mcp/oauth-provider.ts",
        exportName: "McpOAuthProvider.clientInformationForSdkAttempt.err.<callback>",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@ai-sdk/mcp",
        exportName: "OAuthClientProvider.clientInformation",
      },
      direction: "signal-host",
      reason: "OAuthClientProvider requires credential failure through its rejection channel.",
    },
    {
      identity: {
        module: "src/discovery/discovery-service.ts",
        exportName: "adaptDiscoverySearchInputResultToHost.err.<callback>",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "legacy caller exception contract",
      },
      direction: "signal-host",
      reason: "Adapts one typed validation Result to the preserved caller exception contract.",
    },
    {
      identity: {
        module: "src/discovery/discovery-service.ts",
        exportName: "adaptDiscoverySearchResultToHost.err.<callback>",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "legacy caller exception contract",
      },
      direction: "signal-host",
      reason: "Adapts one typed validation Result to the preserved caller exception contract.",
    },
    {
      identity: {
        module: "src/discovery/discovery-service.ts",
        exportName: "adaptDiscoveryCloseResultToHost.err.<callback>",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "legacy caller exception contract",
      },
      direction: "signal-host",
      reason: "Adapts one typed validation Result to the preserved caller exception contract.",
    },
    {
      identity: {
        module: "src/shared/attachment-utils.ts",
        exportName: "resolveToolPathForRequestContext.err.<callback>",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "resolveToolPathForRequestContextResult",
      },
      direction: "signal-host",
      reason: "Adapts one typed validation Result to the preserved caller exception contract.",
    },
    {
      identity: {
        module: "src/shared/attachment-utils.ts",
        exportName: "decodeDataUrl.err.<callback>",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "decodeDataUrlResult",
      },
      direction: "signal-host",
      reason: "Adapts one typed validation Result to the preserved caller exception contract.",
    },
    {
      identity: {
        module: "src/shared/req-context.ts",
        exportName: "requireRequestContext",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "legacy caller exception contract",
      },
      direction: "signal-host",
      reason: "Adapts one typed validation Result to the preserved caller exception contract.",
    },
    {
      identity: {
        module: "src/shared/tool-server-context.ts",
        exportName: "requireToolServerHeaders",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "legacy caller exception contract",
      },
      direction: "signal-host",
      reason: "Adapts one typed validation Result to the preserved caller exception contract.",
    },
    {
      identity: {
        module: "src/ssh/ssh-config.ts",
        exportName: "requireConfiguredSshHost.err.<callback>",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "legacy caller exception contract",
      },
      direction: "signal-host",
      reason: "Adapts one typed validation Result to the preserved caller exception contract.",
    },
    {
      identity: {
        module: "src/surface/adapter.ts",
        exportName: "preserveSurfacePanic",
      },
      category: "defect-supervisor",
      externalApi: {
        package: "better-result",
        exportName: "Panic.is",
      },
      direction: "observe-panic",
      reason: "Preserves exact Panic identity at this reviewed Core defect boundary.",
    },
    {
      identity: {
        module: "src/surface/bridge/request-composition/attachments.ts",
        exportName: "limitDiscordAttachmentStream.transform.err",
      },
      category: "result-to-framework",
      externalApi: {
        package: "global",
        exportName: "TransformStreamDefaultController.error",
      },
      direction: "signal-host",
      reason:
        "Signals a typed Discord attachment limit failure through the TransformStream host contract.",
    },
    {
      identity: {
        module: "src/surface/discord/discord-adapter.ts",
        exportName: "DiscordAdapter.reportDetachedPanic.queueMicrotask.<callback@1>",
      },
      category: "defect-supervisor",
      externalApi: {
        package: "@stanley2058/lilac-core",
        exportName: "fatal Panic reporter",
      },
      direction: "signal-host",
      reason: "Reports a detached Panic through the exact Core fatal host callback.",
    },
    {
      identity: {
        module: "src/surface/bridge/adapter-event-projection.ts",
        exportName: "signalAdapterEventPlatformMismatch",
      },
      category: "defect-supervisor",
      externalApi: {
        package: "better-result",
        exportName: "Panic",
      },
      direction: "signal-host",
      reason: "Signals a hard invariant when a normalized adapter event contains mixed platforms.",
    },
    {
      identity: {
        module: "src/surface/produced-ref-guard.ts",
        exportName: "signalSurfaceAdapterContractViolation",
      },
      category: "defect-supervisor",
      externalApi: {
        package: "better-result",
        exportName: "Panic",
      },
      direction: "signal-host",
      reason:
        "Signals a hard descriptor-bound contract defect before an adapter-produced ref crosses a shared publication or persistence seam.",
    },
    {
      identity: {
        module: "src/surface/github/github-runtime-descriptor.ts",
        exportName: "preserveGithubRelayPolicyPanic",
      },
      category: "defect-supervisor",
      externalApi: {
        package: "better-result",
        exportName: "Panic.is",
      },
      direction: "observe-panic",
      reason: "Preserves exact Panic identity at the GitHub acknowledgement deletion boundary.",
    },
  ],
  "packages/event-bus": [
    {
      identity: {
        module: "redis-event-dead-letter.ts",
        exportName: "RedisEventDeadLetter.constructor",
      },
      category: "compatibility",
      externalApi: {
        package: "global",
        exportName: "constructor",
      },
      direction: "signal-host",
      reason:
        "Converts typed Redis dead-letter configuration validation failure to the constructor host contract.",
    },
  ],
  "packages/plugin-runtime": [
    {
      identity: {
        module: "validation-error-message.ts",
        exportName: "adaptToolInputResultToServerToolHost",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-plugin-runtime",
        exportName: "parseToolInput",
      },
      direction: "signal-host",
      reason: "Preserves the explicit compatibility parser's rejecting host contract.",
    },
    {
      identity: {
        module: "validation-error-message.ts",
        exportName: "adaptToolInputResultToZodHost",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-plugin-runtime",
        exportName: "parseToolInputPreservingZodError",
      },
      direction: "signal-host",
      reason: "Preserves the explicit compatibility parser's rejecting host contract.",
    },
    {
      identity: {
        module: "zod-cli.ts",
        exportName: "adaptZodCliResultToToolHost",
      },
      category: "result-to-framework",
      externalApi: {
        package: "@stanley2058/lilac-plugin-runtime",
        exportName: "ServerTool.list CLI projection",
      },
      direction: "signal-host",
      reason: "Signals invalid internal CLI projection through the list host contract.",
    },
  ],
  "packages/blob-storage": [
    {
      identity: {
        module: "src/backend.ts",
        exportName: "signalBlobAdapterFailure",
      },
      category: "compatibility",
      externalApi: {
        package: "global",
        exportName: "language host failure signal",
      },
      direction: "signal-host",
      reason: "Signals a package-owned adapter failure only inside its immediate Result capture.",
    },
    {
      identity: {
        module: "src/backend.ts",
        exportName: "signalRetainedBlobPanic",
      },
      category: "defect-supervisor",
      externalApi: { package: "better-result", exportName: "Panic.is" },
      direction: "observe-panic",
      reason: "Preserves the exact Panic after an external blob adapter or stream capture.",
    },
    {
      identity: {
        module: "src/backend.ts",
        exportName: "signalBlobDefect",
      },
      category: "defect-supervisor",
      externalApi: {
        package: "global",
        exportName: "language host failure signal",
      },
      direction: "signal-host",
      reason: "Escalates an unexpected rejected serialization or lock value as a retained Panic.",
    },
    {
      identity: {
        module: "src/store.ts",
        exportName: "createVerifiedRead.pull",
      },
      category: "result-to-framework",
      externalApi: {
        package: "global",
        exportName: "ReadableStreamDefaultController.error",
      },
      direction: "signal-host",
      reason: "Signals a settled BlobReadSourceFailure through the ReadableStream host contract.",
    },
    {
      identity: {
        module: "src/local-backend.ts",
        exportName: "normalizeNodeFileReadableStream.pull",
      },
      category: "result-to-framework",
      externalApi: {
        package: "global",
        exportName: "ReadableStreamDefaultController.error",
      },
      direction: "signal-host",
      reason:
        "Signals a settled local file read failure or non-byte host value through the ReadableStream contract.",
    },
  ],
  "packages/tool-results": [
    {
      identity: {
        module: "src/blob-tool-result-artifact-store.ts",
        exportName: "rethrowBlobToolResultPanic",
      },
      category: "defect-supervisor",
      externalApi: {
        package: "global",
        exportName: "language host failure signal",
      },
      direction: "signal-host",
      reason:
        "Narrow typed helper preserves Panic identity after blob-backed artifact operations leave their Result capture.",
    },
  ],
  "packages/utils": [
    {
      identity: { module: "model-catalog-cache.ts", exportName: "signalCatalogDefect" },
      category: "defect-supervisor",
      externalApi: { package: "global", exportName: "model catalog refresh Promise" },
      direction: "signal-host",
      reason:
        "Preserves catalog I/O Panic and refresh defects after best-effort cache policy; Core supervises detached refreshes and standalone callers receive rejection.",
    },
    {
      identity: {
        module: "persistence.ts",
        exportName: "runBunSqliteTransaction",
      },
      category: "rollback",
      externalApi: {
        package: "bun:sqlite",
        exportName: "Database.transaction.immediate",
      },
      direction: "signal-host",
      reason:
        "Signals a logical Err through Bun's transaction callback and escalates unknown transaction atomicity.",
    },
    {
      identity: {
        module: "persistence.ts",
        exportName: "runBunSqliteTransaction.try@1.transaction.<callback@1>",
      },
      category: "rollback",
      externalApi: {
        package: "bun:sqlite",
        exportName: "Database.transaction.immediate",
      },
      direction: "signal-host",
      reason: "Throws the private rollback sentinel only inside Bun's exact transaction callback.",
    },
  ],
};
