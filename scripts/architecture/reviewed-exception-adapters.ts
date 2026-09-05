import type { ExceptionAdapter } from "./manifest.ts";

export const REVIEWED_EXCEPTION_ADAPTERS: Readonly<Record<string, readonly ExceptionAdapter[]>> = {
  "apps/core": [
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
