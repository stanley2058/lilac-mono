import { createHash } from "node:crypto";

import { ARCHITECTURE_RULES, type ArchitectureRule } from "./model.ts";
import {
  CORE_FINAL_BOUNDARY_IDENTITIES,
  CORE_FINAL_CAPABILITY_IDENTITIES,
  CORE_FINAL_REVIEWED_OPAQUE_IDENTITIES,
} from "./core-final-boundary-identities.ts";
import {
  CORE_FATAL_SIGNAL_IDENTITIES,
  CORE_REVIEWED_PANIC_IDENTITIES,
  PRECISE_EXCEPTION_IDENTITIES,
} from "./precise-exception-identities.ts";
import { REVIEWED_EXCEPTION_ADAPTERS } from "./reviewed-exception-adapters.ts";

export type BoundaryCategory = "request" | "wire" | "persistence" | "projection" | "plugin";
export type CompatibilityCategory =
  | "http"
  | "redis"
  | "worker"
  | "subprocess"
  | "persistence"
  | "tool"
  | "plugin";
export type ExceptionAdapterCategory =
  | "result-to-framework"
  | "rollback"
  | "compatibility"
  | "defect-supervisor";
export type ExceptionDirection = "signal-host" | "observe-panic";

export interface SymbolIdentity {
  readonly module: string;
  readonly exportName: string;
}

export interface PackageSymbolIdentity extends SymbolIdentity {
  readonly package?: string;
}

export interface PackageModuleIdentity {
  readonly workspace: string;
  readonly module: string;
}

export interface BlobStorageArchitecturePolicy {
  readonly storageWorkspace: string;
  readonly storagePackage: string;
  readonly coreWorkspace: string;
  readonly eventSchemaModules: readonly PackageModuleIdentity[];
  readonly adapterFactoryExports: readonly string[];
  readonly adapterFactoryOwners: readonly PackageModuleIdentity[];
  readonly closeOwnerModules: readonly PackageModuleIdentity[];
  readonly materializationModules: readonly PackageModuleIdentity[];
  readonly migrationEntrypoint: string;
  readonly migrationModules: readonly PackageModuleIdentity[];
  readonly allowedCoreBlobColumns: readonly string[];
}

export interface ExternalSymbolIdentity {
  readonly package: string;
  readonly exportName: string;
}

export type CompatibilitySink =
  | ({ readonly kind: "external" } & ExternalSymbolIdentity)
  | ({ readonly kind: "local" } & SymbolIdentity);

export interface BoundaryDecoder {
  readonly identity: SymbolIdentity;
  readonly category: BoundaryCategory;
}

export interface ReasonedSymbolException {
  readonly identity: SymbolIdentity;
  readonly reason: string;
}

export interface CompatibilityOutput {
  readonly sink: CompatibilitySink;
  readonly category: CompatibilityCategory;
  readonly reason: string;
}

export interface StructuredLogger {
  readonly sink: CompatibilitySink;
  readonly reason: string;
}

export interface ExceptionAdapter {
  readonly identity: SymbolIdentity;
  readonly category: ExceptionAdapterCategory;
  readonly externalApi: ExternalSymbolIdentity;
  readonly direction: ExceptionDirection;
  readonly reason: string;
}

export type ExceptionAdapterSyntaxKind =
  | "throw-statement"
  | "host-rejection-call"
  | "registered-host-signal-call"
  | "panic-observation";

export type ExceptionAdapterProvenance =
  | "precise-exception-identities"
  | "core-reviewed-panic-identities"
  | "core-fatal-signal-identities"
  | "workspace-reviewed-manifest";

export type ExceptionAdapterRelationship =
  | "external-package"
  | "host-contract"
  | "language-runtime"
  | "panic-brand";

export interface ApprovedExceptionAdapter {
  readonly workspace: string;
  readonly callable: SymbolIdentity;
  readonly category: ExceptionAdapterCategory;
  readonly externalApi: ExternalSymbolIdentity;
  readonly mode: ExceptionDirection;
  readonly syntaxKinds: readonly ExceptionAdapterSyntaxKind[];
  readonly relationship: ExceptionAdapterRelationship;
  readonly provenance: ExceptionAdapterProvenance;
  readonly reason: string;
}

export interface OpenProtocolAdapter {
  readonly identity: SymbolIdentity;
  readonly externalProtocol: ExternalSymbolIdentity;
  readonly protocolParameter: number;
  readonly fallbackVariant: {
    readonly discriminant: string;
    readonly value: string;
  };
  readonly reason: string;
}

export interface PanicSite {
  readonly fingerprint: string;
  readonly reason: string;
}

export interface RuleZone {
  readonly include: string;
}

export interface EventCodecRegistryRegistration {
  readonly identity: SymbolIdentity;
  readonly catalog: SymbolIdentity;
  readonly catalogHelper: SymbolIdentity;
  readonly registryHelper: SymbolIdentity;
}

export interface ToolCodecRegistryRegistration {
  readonly identity: SymbolIdentity;
  readonly aliases: readonly SymbolIdentity[];
  readonly canonicalTools: PackageSymbolIdentity;
}

export interface ResultDecoderRegistration {
  readonly identity: SymbolIdentity;
  readonly category: BoundaryCategory;
  readonly inputParameter: number;
}

export interface UnknownFreeModuleRegistration {
  readonly module: string;
}

export const PERSISTED_CODEC_FIXTURE_CASES = [
  "current",
  "legacy",
  "missing-defaulted",
  "unsupported-version",
  "malformed-serialization",
  "corrupt-fields",
] as const;

export type PersistedCodecFixtureCase = (typeof PERSISTED_CODEC_FIXTURE_CASES)[number];
export type PersistedValueProvenance = "current" | "migrated" | "missing-defaulted";
export type PersistedMissingOutcome = "missing-defaulted" | "missing-rejected";
export type PersistedLegacyOutcome = "migrated" | "rejected";

export interface PersistedCodecRegistration {
  readonly identity: SymbolIdentity;
  readonly inputParameter: number;
  readonly fixtureCatalog: SymbolIdentity;
  readonly provenance: readonly PersistedValueProvenance[];
  readonly legacyOutcome?: PersistedLegacyOutcome;
  readonly missingOutcomes?: Readonly<Record<string, PersistedMissingOutcome>>;
}

export interface PersistedStoreConsumerRegistration {
  readonly identity: SymbolIdentity;
  readonly codecs: readonly PackageSymbolIdentity[];
}

export interface SqliteTransactionAdapterRegistration {
  readonly identity: SymbolIdentity;
  readonly databaseParameter: number;
  readonly operationParameter: number;
  readonly rollbackSentinel: SymbolIdentity;
  readonly panicClassifier: ExternalSymbolIdentity;
  readonly driverErrorClassifier: SymbolIdentity;
}

export interface SqliteTransactionConsumerRegistration {
  readonly identity: SymbolIdentity;
  readonly adapter: PackageSymbolIdentity;
}

export interface RawEventMessageBoundaryRegistration {
  readonly identity: SymbolIdentity;
  readonly messageType: ExternalSymbolIdentity;
  readonly handlerParameter: number;
  readonly messageParameter: number;
  readonly contextParameter: number;
}

export interface EventDeliveryApiRegistration {
  readonly identity: SymbolIdentity;
  readonly handlerParameter: number;
  readonly handlerMessageParameter: number;
  readonly handlerContextParameter: number;
  readonly deliveryPolicy: SymbolIdentity;
  readonly deliveryErrorParameter: number;
}

export type EventDeliveryOperation = "subscribeTopic" | "fetchTopic";

export interface EventDeliveryConsumerRegistration {
  readonly identity: SymbolIdentity;
  readonly apiPackage: string;
  readonly operations: readonly EventDeliveryOperation[];
}

export interface WorkspaceArchitecture {
  readonly name: string;
  readonly packageName: string;
  readonly root: string;
  readonly tsconfig: string;
  readonly ruleZones: Partial<Readonly<Record<ArchitectureRule, readonly RuleZone[]>>>;
  readonly boundaryDecoders: readonly BoundaryDecoder[];
  readonly opaqueUnknown: readonly ReasonedSymbolException[];
  readonly capabilityPredicates: readonly ReasonedSymbolException[];
  readonly exceptionAdapters: readonly ExceptionAdapter[];
  readonly openProtocolAdapters: readonly OpenProtocolAdapter[];
  readonly panicSites: readonly PanicSite[];
  readonly compatibilityOutputs: readonly CompatibilityOutput[];
  readonly structuredLoggers: readonly StructuredLogger[];
  readonly taggedErrorFormatters: readonly CompatibilitySink[];
  readonly operationalResultApis: readonly SymbolIdentity[];
  readonly eventCodecRegistries: readonly EventCodecRegistryRegistration[];
  readonly toolCodecRegistries: readonly ToolCodecRegistryRegistration[];
  readonly resultDecoders: readonly ResultDecoderRegistration[];
  readonly unknownFreeModules: readonly UnknownFreeModuleRegistration[];
  readonly persistedCodecs: readonly PersistedCodecRegistration[];
  readonly persistedStoreConsumers: readonly PersistedStoreConsumerRegistration[];
  readonly sqliteTransactionAdapters: readonly SqliteTransactionAdapterRegistration[];
  readonly sqliteTransactionConsumers: readonly SqliteTransactionConsumerRegistration[];
  readonly rawEventMessageBoundaries: readonly RawEventMessageBoundaryRegistration[];
  readonly eventDeliveryApis: readonly EventDeliveryApiRegistration[];
  readonly eventDeliveryConsumers: readonly EventDeliveryConsumerRegistration[];
}

type WorkspaceArchitectureWithoutExceptionAdapters = Omit<
  WorkspaceArchitecture,
  "exceptionAdapters"
> & {
  readonly exceptionAdapters: readonly [];
};

export type ArchitectureManifest =
  | {
      readonly version: 1;
      readonly approvedExceptionAdapters?: undefined;
      readonly approvedExceptionAdapterCatalogSha256?: undefined;
      readonly workspaces: readonly WorkspaceArchitectureWithoutExceptionAdapters[];
    }
  | {
      readonly version: 1;
      readonly approvedExceptionAdapters: readonly ApprovedExceptionAdapter[];
      readonly approvedExceptionAdapterCatalogSha256: string;
      readonly workspaces: readonly WorkspaceArchitecture[];
    };

export const EXACT_REGISTRATION_ARCHITECTURE_RULES = new Set<ArchitectureRule>([
  "architecture/open-protocol-normalization",
  "architecture/raw-event-message-boundary",
  "architecture/complete-event-codec-registry",
  "architecture/complete-tool-codec-registry",
  "architecture/result-decoder-contract",
  "architecture/unknown-free-module",
  "architecture/persisted-codec-contract",
  "architecture/persisted-codec-fixture-catalog",
  "architecture/sqlite-transaction-adapter-contract",
  "architecture/sqlite-transaction-consumer",
  "architecture/no-result-err-in-sqlite-callback",
  "architecture/event-handler-result",
  "architecture/event-delivery-policy-exhaustiveness",
]);

export const FINAL_PACKAGE_WIDE_ARCHITECTURE_RULES = [
  "architecture/no-unregistered-decoder",
  "architecture/no-domain-unknown",
  "architecture/no-unknown-assertion",
  "architecture/no-rich-unknown-predicate",
  "architecture/no-unknown-member-read",
  "architecture/no-unregistered-custom-decoder",
  "architecture/closed-union-exhaustiveness",
  "architecture/closed-union-map-exhaustiveness",
  "architecture/no-production-unwrap",
  "architecture/no-manual-result-branching",
  "architecture/no-unmapped-result-capture",
  "architecture/no-unhandled-exception-contract",
  "architecture/registered-panic-site",
  "architecture/no-result-wire-leak",
  "architecture/no-unredacted-tagged-error-log",
  "architecture/fallible-api-result",
] as const satisfies readonly ArchitectureRule[];

const DEFAULT_RULE_ZONES = Object.fromEntries(
  ARCHITECTURE_RULES.map((rule) => [
    rule,
    EXACT_REGISTRATION_ARCHITECTURE_RULES.has(rule) ? [] : [{ include: "**" }],
  ]),
);

const EMPTY_POLICY = {
  ruleZones: DEFAULT_RULE_ZONES,
  boundaryDecoders: [],
  opaqueUnknown: [],
  capabilityPredicates: [],
  exceptionAdapters: [],
  openProtocolAdapters: [],
  panicSites: [],
  compatibilityOutputs: [],
  structuredLoggers: [],
  taggedErrorFormatters: [],
  operationalResultApis: [],
  eventCodecRegistries: [],
  toolCodecRegistries: [],
  resultDecoders: [],
  unknownFreeModules: [],
  persistedCodecs: [],
  persistedStoreConsumers: [],
  sqliteTransactionAdapters: [],
  sqliteTransactionConsumers: [],
  rawEventMessageBoundaries: [],
  eventDeliveryApis: [],
  eventDeliveryConsumers: [],
} as const;

export const ACTIVE_WORKSPACES = [
  ["apps/acp-controller", "@stanley2058/lilac-acp-controller"],
  ["apps/core", "@stanley2058/lilac-core"],
  ["apps/mini-lilac", "@stanley2058/mini-lilac"],
  ["apps/mini-lilac-server", "@stanley2058/mini-lilac-server"],
  ["apps/mini-lilac-tui", "@stanley2058/mini-lilac-tui"],
  ["apps/tool-bridge", "@stanley2058/lilac-tool-bridge"],
  ["packages/agent", "@stanley2058/lilac-agent"],
  ["packages/bash-safety", "@stanley2058/lilac-bash-safety"],
  ["packages/blob-storage", "@stanley2058/lilac-blob-storage"],
  ["packages/claude-code-bridge", "@stanley2058/lilac-claude-code-bridge"],
  ["packages/coding-tools", "@stanley2058/lilac-coding-tools"],
  ["packages/event-bus", "@stanley2058/lilac-event-bus"],
  ["packages/fs", "@stanley2058/lilac-fs"],
  ["packages/mini-lilac-client", "@stanley2058/mini-lilac-client"],
  ["packages/mini-lilac-runtime", "@stanley2058/mini-lilac-runtime"],
  ["packages/plugin-runtime", "@stanley2058/lilac-plugin-runtime"],
  ["packages/remote-fs-runner", "@stanley2058/lilac-remote-fs-runner"],
  ["packages/tool-results", "@stanley2058/lilac-tool-results"],
  ["packages/utils", "@stanley2058/lilac-utils"],
] as const;

export const BLOB_STORAGE_ARCHITECTURE_POLICY = {
  storageWorkspace: "packages/blob-storage",
  storagePackage: "@stanley2058/lilac-blob-storage",
  coreWorkspace: "apps/core",
  eventSchemaModules: [{ workspace: "packages/event-bus", module: "lilac-spec" }],
  adapterFactoryExports: ["createLocalBlobStore", "createS3BlobStore"],
  adapterFactoryOwners: [
    { workspace: "apps/core", module: "src/runtime/create-core-blob-store" },
    { workspace: "apps/core", module: "scripts/blob-migration-target" },
  ],
  closeOwnerModules: [
    { workspace: "apps/core", module: "src/runtime/main" },
    { workspace: "apps/core", module: "scripts/bench-blob-storage" },
    { workspace: "apps/core", module: "scripts/migrate-blob-storage" },
  ],
  materializationModules: [
    {
      workspace: "apps/core",
      module: "src/surface/bridge/bus-agent-runner/anthropic-fallback-media",
    },
    {
      workspace: "apps/core",
      module: "src/surface/bridge/generated-output-materialization",
    },
    {
      workspace: "apps/core",
      module: "src/surface/bridge/request-composition/attachments",
    },
    {
      workspace: "apps/core",
      module: "src/surface/bridge/request-composition/prepare-bus-messages",
    },
    { workspace: "apps/core", module: "src/resource/service" },
    { workspace: "apps/core", module: "src/tool-server/tools/attachment" },
    { workspace: "apps/core", module: "src/workflow/workflow-artifact-store" },
    {
      workspace: "packages/tool-results",
      module: "src/blob-tool-result-artifact-store",
    },
    {
      workspace: "apps/core",
      module: "src/transcript/stored-message-materialization",
    },
    { workspace: "apps/core", module: "scripts/blob-migration-target" },
    { workspace: "apps/core", module: "scripts/bench-blob-storage" },
    {
      workspace: "apps/core",
      module: "scripts/legacy-workflow-blob-migration",
    },
  ],
  migrationEntrypoint: "apps/core/scripts/migrate-blob-storage",
  migrationModules: [
    { workspace: "apps/core", module: "scripts/migrate-blob-storage" },
    { workspace: "apps/core", module: "scripts/blob-migration-target" },
    {
      workspace: "apps/core",
      module: "scripts/legacy-graceful-restart-blob-migration",
    },
    {
      workspace: "apps/core",
      module: "scripts/legacy-transcript-blob-migration",
    },
    { workspace: "apps/core", module: "scripts/legacy-transient-blob-state" },
    {
      workspace: "apps/core",
      module: "scripts/legacy-workflow-blob-migration",
    },
  ],
  allowedCoreBlobColumns: ["embedding"],
} as const satisfies BlobStorageArchitecturePolicy;

export type ActiveWorkspaceRoot = (typeof ACTIVE_WORKSPACES)[number][0];

const STAGE_3_OPERATIONAL_RESULT_APIS = new Map<string, readonly SymbolIdentity[]>([
  [
    "packages/blob-storage",
    [
      ...[
        "createLocalBlobStore",
        "createS3BlobStore",
        "createMemoryBlobStore",
        "preflightLocalBlobStore",
        "preflightS3BlobStore",
      ].map((exportName) => ({ module: "src/factories.ts", exportName })),
      { module: "src/backend.ts", exportName: "captureAdapterOperation" },
      ...[
        "SupervisedBlobStore.startUpload",
        "SupervisedBlobStore.resolve",
        "SupervisedBlobStore.open",
        "SupervisedBlobStore.delete",
        "SupervisedBlobStore.maintain",
        "SupervisedBlobStore.close",
        "materializeBlobRead",
      ].map((exportName) => ({ module: "src/store.ts", exportName })),
    ],
  ],
  [
    "packages/bash-safety",
    [
      {
        module: "src/analyze/analyze-command.ts",
        exportName: "parseBashCommand",
      },
      { module: "src/rules-filesystem.ts", exportName: "readGitMetadataFile" },
      { module: "src/rules-rm.ts", exportName: "resolveRmPaths" },
    ],
  ],
  [
    "apps/core",
    [
      {
        module: "src/conversation/thread-summarization-worker-protocol.ts",
        exportName: "decodeThreadSummarizationWorkerRequest",
      },
      {
        module: "src/conversation/thread-summarization-worker-protocol.ts",
        exportName: "decodeThreadSummarizationWorkerResponse",
      },
      {
        module: "src/conversation/thread-summarization-worker-protocol.ts",
        exportName: "decodeThreadSummarizationParentMessage",
      },
      {
        module: "src/conversation/thread-summarization-worker-protocol.ts",
        exportName: "decodeThreadSummarizationWorkerMessage",
      },
      {
        module: "src/conversation/thread-worker.ts",
        exportName: "ConversationThreadSummarizationRunner.runSummarization",
      },
      {
        module: "src/conversation/thread-worker.ts",
        exportName: "startConversationThreadSummarizationWorker.postRequest",
      },
      {
        module: "src/conversation/thread-worker.ts",
        exportName: "startConversationThreadSummarizationWorker.runSummarization",
      },
      ...["importCustomCommandModule", "invokeCustomCommand", "settleCustomCommand"].map(
        (exportName) => ({
          module: "src/custom-commands/manager.ts",
          exportName,
        }),
      ),
      {
        module: "src/custom-commands/manager.ts",
        exportName: "CustomCommandManager.execute",
      },
      {
        module: "src/heartbeat/heartbeat-service.ts",
        exportName: "startHeartbeatServiceResult.startHeartbeatLifecycleResult",
      },
      {
        module: "src/heartbeat/heartbeat-service.ts",
        exportName: "startHeartbeatServiceResult.stopHeartbeatLifecycleResult",
      },
      ...[
        "decodeRemoteFsRunnerPackageSpec",
        "buildRemoteFsRunnerCommand",
        "sshExecRemoteFsRunnerJson",
        "remoteReadTextFile",
        "remoteReadFileBytes",
        "remoteGlob",
        "remoteGrep",
        "remoteFuzzySearch",
        "remoteEditFile",
      ].map((exportName) => ({
        module: "src/tools/fs/remote-fs.ts",
        exportName,
      })),
      ...[
        "validateToolServerOptions",
        "decodeToolRequestHeaders",
        "decodeToolPayload",
        "normalizeSuccessfulToolValue",
        "createToolServer.authenticateContext",
        "createToolServer.captureAuthenticationOperation",
        "createToolServer.resolveSafetyMode",
        "createToolServer.lookupTool",
        "createToolServer.lookupHelpTool",
      ].map((exportName) => ({
        module: "src/tool-server/create-tool-server.ts",
        exportName,
      })),
      {
        module: "src/runtime/core-dead-letter-key.ts",
        exportName: "loadOrCreateCoreDeadLetterKey",
      },
      {
        module: "src/runtime/create-core-blob-store.ts",
        exportName: "createCoreBlobStore",
      },
      {
        module: "scripts/legacy-workflow-blob-migration.ts",
        exportName: "inspectLegacyWorkflowBlobMigration",
      },
      ...["preflightLegacyGracefulRestartMigration", "commitLegacyGracefulRestartMigration"].map(
        (exportName) => ({
          module: "scripts/legacy-graceful-restart-blob-migration.ts",
          exportName,
        }),
      ),
      ...[
        "createCoreRequestDeliveryAdmission.validateAndBuildWork",
        "createLilacBusRequestDeliveryPublisher.acquire",
        "createLilacBusRequestDeliveryPublisher.publish",
        "createLilacBusRequestDeliveryPublisher.confirm",
        "createLilacBusRequestDeliveryPublisher.abandon",
        "createRequestDeliveryPostCommitObserver.observe",
        "corePreparedEnvelopeFromCommand",
      ].map((exportName) => ({
        module: "src/surface/bridge/request-delivery/core-integration.ts",
        exportName,
      })),
      {
        module: "src/surface/bridge/request-delivery/durable-request-bus.ts",
        exportName: "createDurableCoreRequestBus.bus.publish",
      },
      ...[
        "readStreamChunk",
        "readResponseBody",
        "openOverflowSink",
        "writeOverflowSink",
        "closeOverflowSink",
        "abortOverflowSink",
        "removeOverflowFile",
        "cleanupOverflowCapture",
        "writeOverflowChunk",
        "activateOverflowCapture",
        "readReadableStreamTextCapped",
        "readBodyTextCapped",
        "readStreamTextCapped",
        "waitForSshExit",
        "serializeRemoteRunnerRequestJson",
      ].map((exportName) => ({ module: "src/ssh/ssh-exec.ts", exportName })),
    ],
  ],
  [
    "packages/fs",
    [
      {
        module: "src/filesystem-operation.ts",
        exportName: "captureFilesystemOperation",
      },
      {
        module: "src/filesystem-operation.ts",
        exportName: "captureFilesystemOperationSync",
      },
      { module: "src/fs-impl.ts", exportName: "canonicalizePathAsFarAsExists" },
      { module: "src/fs-impl.ts", exportName: "compileEditRegex" },
      { module: "src/hashline.ts", exportName: "applyHashlineEdits" },
      { module: "src/ripgrep.ts", exportName: "decodeRipgrepMatchLine" },
      { module: "src/ripgrep.ts", exportName: "ripgrep" },
      { module: "src/search-backend.ts", exportName: "captureFffOperation" },
      {
        module: "src/search-backend.ts",
        exportName: "captureFffSyncOperation",
      },
      ...[
        "decodeBundledRemoteRunnerRequest",
        "decodeBundledRemoteRunnerRequestJson",
        "decodeRemoteFsRequest",
        "decodeRemoteFsRequestJson",
        "decodeRemoteFsDaemonRequest",
        "decodeRemoteFsDaemonRequestJson",
        "decodeRemoteRunnerResponse",
        "decodeRemoteRunnerResponseJson",
        "decodeRemoteRunnerResponseValue",
      ].map((exportName) => ({
        module: "src/remote-runner-protocol.ts",
        exportName,
      })),
    ],
  ],
  [
    "packages/tool-results",
    [
      {
        module: "src/tool-result-artifact-store.ts",
        exportName: "createToolResultArtifactStore.captureOperation",
      },
      {
        module: "src/tool-result-artifact-store.ts",
        exportName: "validateHardLimit",
      },
      {
        module: "src/tool-result-output-normalizer.ts",
        exportName: "serializeOutput",
      },
    ],
  ],
  [
    "packages/coding-tools",
    [
      { module: "src/apply-patch.ts", exportName: "parsePatchResult" },
      { module: "src/apply-patch.ts", exportName: "applyPatchResult" },
      {
        module: "src/batch.ts",
        exportName: "collectApplyPatchTouchedPathsResult",
      },
      {
        module: "src/batch.ts",
        exportName: "collectEditFileTouchedPathsResult",
      },
      { module: "src/batch.ts", exportName: "createBatchToolResult" },
      { module: "src/guardrails.ts", exportName: "guardrailBypassAllowed" },
      { module: "src/guardrails.ts", exportName: "validateLocalCwd" },
      {
        module: "src/guardrails.ts",
        exportName: "canonicalizeAsFarAsExistsResult",
      },
      { module: "src/guardrails.ts", exportName: "canonicalPathAllowed" },
      { module: "src/index.ts", exportName: "createCodingToolsetResult" },
    ],
  ],
  [
    "packages/event-bus",
    [
      {
        module: "core-primary-lineage.ts",
        exportName: "extendCoreLineagePrefixDigestV2",
      },
      {
        module: "core-primary-lineage.ts",
        exportName: "buildCoreLineageManifestV2",
      },
      {
        module: "core-primary-lineage.ts",
        exportName: "decodeCorePrimaryLineageV2",
      },
      {
        module: "core-primary-lineage.ts",
        exportName: "createCorePrimaryLineageFreshOnlyV2",
      },
      {
        module: "redis-connection-pool.ts",
        exportName: "RedisConnectionPool.acquire",
      },
      {
        module: "redis-event-dead-letter.ts",
        exportName: "validateRedisEventDeadLetterConfig",
      },
      {
        module: "redis-event-dead-letter.ts",
        exportName: "decodeRedisEventDeadLetterCiphertextEnvelope",
      },
      {
        module: "redis-event-dead-letter.ts",
        exportName: "encryptRedisEventDeadLetterRecoveryValue",
      },
      {
        module: "redis-event-dead-letter.ts",
        exportName: "decryptRedisEventDeadLetterRecoveryValue",
      },
      {
        module: "redis-event-dead-letter.ts",
        exportName: "decryptRedisEventDeadLetterRecord",
      },
      { module: "lilac-bus.ts", exportName: "LilacBus.subscribeTopic" },
      { module: "lilac-bus.ts", exportName: "LilacBus.getOutputStreamExpiry" },
    ],
  ],
  [
    "packages/mini-lilac-client",
    [
      {
        module: "mini-lilac-transport.ts",
        exportName: "decodeMiniLilacBoundary",
      },
      ...[
        "sendMessagesResult",
        "reconnectToStreamResult",
        "getSessionResult",
        "getSessionResumeResult",
        "listSessionsResult",
        "getMessagesResult",
        "streamSessionResult",
        "getTodosResult",
        "listModelsResult",
        "listProfilesResult",
        "listSkillsResult",
        "updateSessionBindingsResult",
        "steerResult",
        "interruptQueuedSteeringResult",
        "cancelResult",
        "undoResult",
        "redoResult",
        "cancelCompactionResult",
        "compactResult",
      ].map((method) => ({
        module: "mini-lilac-transport.ts",
        exportName: `MiniLilacTransport.${method}`,
      })),
    ],
  ],
  [
    "packages/claude-code-bridge",
    [
      ...["decodeClaudeContextUsage", "decodeClaudeStopHookInput", "decodeClaudeSessionInfo"].map(
        (exportName) => ({ module: "claude-code-run.ts", exportName }),
      ),
      ...[
        "validateClaudeCodeBuiltInToolsResult",
        "mapToolResultOutputToMcpResult",
        "createClaudeCodeToolBridgeResult.closeResult",
      ].map((exportName) => ({ module: "claude-code-tools.ts", exportName })),
      ...[
        "getNativeInputEstimateFloorResult",
        "recordSuccessfulModelCallResult",
        "retireForRetryResult",
        "retireForCanonicalReplacementResult",
        "retireAtRunEndResult",
        "prepareResult",
      ].map((method) => ({
        module: "claude-attempt-runtime-owner.ts",
        exportName: `ClaudeAttemptRuntimeOwner.${method}`,
      })),
    ],
  ],
  [
    "packages/utils",
    [
      { module: "codex-oauth.ts", exportName: "decodeCodexTokens" },
      { module: "codex-oauth.ts", exportName: "writeSecretFileResult" },
      { module: "codex-oauth.ts", exportName: "readCodexTokensResult" },
      { module: "codex-oauth.ts", exportName: "writeCodexTokensResult" },
      { module: "codex-oauth.ts", exportName: "clearCodexTokensResult" },
      { module: "codex-oauth.ts", exportName: "exchangeCodeForTokensResult" },
      { module: "codex-oauth.ts", exportName: "refreshAccessTokenResult" },
      {
        module: "codex-oauth.ts",
        exportName: "startCodexOAuthLogin.runExchangeResult",
      },
      {
        module: "codex-oauth.ts",
        exportName: "startCodexOAuthLogin.exchangeResult",
      },
      { module: "core-config.ts", exportName: "decodeCoreConfigYaml" },
      { module: "core-config.ts", exportName: "readCoreConfigVersionResult" },
      { module: "core-config.ts", exportName: "parseCoreConfigResult" },
      { module: "core-config.ts", exportName: "resolveDiscordTokenResult" },
      { module: "core-config/v1.ts", exportName: "decodeCoreConfigV1" },
      {
        module: "core-config/v1.ts",
        exportName: "decodeCoreConfigV1ToUniversal",
      },
      { module: "core-config/v2.ts", exportName: "decodeCoreConfigV2" },
      {
        module: "core-config/v2.ts",
        exportName: "decodeCoreConfigV2ToUniversal",
      },
      { module: "find-root.ts", exportName: "hasWorkspacesFieldResult" },
      { module: "find-root.ts", exportName: "findWorkspaceRootResult" },
      {
        module: "friendly-units.ts",
        exportName: "parseFriendlyByteSizeResult",
      },
      {
        module: "friendly-units.ts",
        exportName: "parseFriendlyDurationMsResult",
      },
      {
        module: "model-capability.ts",
        exportName: "parseModelSpecifierResult",
      },
      {
        module: "model-capability.ts",
        exportName: "ModelCapability.resolveResult",
      },
      {
        module: "model-provider.ts",
        exportName: "normalizeCodexResponsesRequestRecordResult",
      },
      ...[
        "fromDurableResolvedModelRequestResult",
        "fromDurableResolvedModelPlanResult",
        "resolveModelRefResult",
        "resolveModelChainResult",
        "resolveModelPlanResult",
        "resolveModelSlotResult",
      ].map((exportName) => ({ module: "model-slot.ts", exportName })),
      {
        module: "openai-responses-websocket-fetch.ts",
        exportName: "decodeResponsesRequestBody",
      },
      {
        module: "server-compaction-request.ts",
        exportName: "decodeServerCompactionPayload",
      },
      {
        module: "server-compaction-request.ts",
        exportName: "prepareServerCompactionRequestResult",
      },
      { module: "skills.ts", exportName: "readTextPrefixResult" },
      { module: "skills.ts", exportName: "parseSkillMarkdownResult" },
    ],
  ],
  [
    "packages/plugin-runtime",
    [
      ...[
        "decodeDynamicToolPluginModule",
        "decodeToolPlugin",
        "decodeToolPluginInstance",
        "decodeLevel1ToolSpec",
        "decodeServerTool",
        "decodeVoidHookResult",
        "decodeBooleanHookResult",
        "decodeStringHookResult",
        "decodeStringArrayHookResult",
        "decodeServerToolListResult",
        "decodeLevel1ToolFailureSummary",
        "decodeLevel1ExecutableMetadata",
        "decodeDisabledPluginIds",
        "decodeLevel1RegistrationKey",
      ].map((exportName) => ({ module: "capabilities.ts", exportName })),
      ...[
        "invokeToolPluginCreate",
        "invokeToolPluginInstanceInit",
        "invokeToolPluginInstanceDestroy",
        "invokeLevel1CreateTool",
        "invokeLevel1IsEnabled",
        "invokeLevel1EditTargets",
        "invokeLevel1FormatArgs",
        "invokeLevel1SummarizeFailure",
        "invokeLevel2Init",
        "invokeLevel2Destroy",
        "invokeLevel2List",
        "invokeLevel2Call",
      ].map((exportName) => ({ module: "hooks.ts", exportName })),
      ...["discoverExternalToolPlugins", "buildExternalToolPluginFreshnessKey"].map(
        (exportName) => ({ module: "discovery.ts", exportName }),
      ),
      ...["loadToolPluginModuleCapability", "loadToolPluginModule"].map((exportName) => ({
        module: "loader.ts",
        exportName,
      })),
      ...[
        "init",
        "destroy",
        "reload",
        "ensureFresh",
        "acquireGeneration.release",
        "retireGeneration",
        "cleanupRetiredGeneration",
      ].map((method) => ({
        module: "manager.ts",
        exportName: `ToolPluginManager.${method}`,
      })),
    ],
  ],
  [
    "packages/remote-fs-runner",
    [
      "captureRuntimeOperation",
      "ensureRuntimeDir",
      "readStdinText",
      "readSocketResponse",
      "decodeSocketResponse",
      "connectOnce",
      "spawnDaemon",
      "tryConnectUntil",
      "tryAcquireStartupLock",
      "releaseStartupLock",
      "applyStartupLockCleanup",
      "runWithStartupLockCleanup",
      "runRequest",
      "executeDaemonRequest",
      "runDaemon",
    ].map((exportName) => ({ module: "src/cli.ts", exportName })),
  ],
]);

const CORE_TOOL_SERVER_BOUNDARY_DECODERS = [
  ...[
    "isCurrentSessionScopedSurfaceCall",
    "isRestrictedCallableAllowed",
    "createToolServer.pluginCallCompatibilityError",
    "createToolServer.<callback>.<callback>",
    "createToolServer.<callback>",
  ].map((exportName) => ({
    identity: { module: "src/tool-server/create-tool-server.ts", exportName },
    category: "request" as const,
  })),
  ...[
    "normalizeAttachmentAddFilesInput",
    "asBuffer",
    "downloadToBuffer",
    "Attachment.callDownload",
    "collectUserResourceUris",
    "collectUserBlobAttachments",
  ].map((exportName) => ({
    identity: { module: "src/tool-server/tools/attachment.ts", exportName },
    category: "plugin" as const,
  })),
  {
    identity: {
      module: "src/tool-server/tools/content-inspect.ts",
      exportName: "inferContentInspectType",
    },
    category: "request",
  },
  {
    identity: {
      module: "src/tool-server/tools/programmatic-workflow.ts",
      exportName: "hasSensitiveSchema.visit",
    },
    category: "projection",
  },
  {
    identity: {
      module: "src/tool-server/tools/programmatic-workflow.ts",
      exportName: "decodeWorkflowJsonObject",
    },
    category: "projection",
  },
  {
    identity: {
      module: "src/tool-server/tools/programmatic-workflow.ts",
      exportName: "projectWorkflowJsonObject",
    },
    category: "projection",
  },
  ...[
    "withDefaultSessionId",
    "withDefaultMessageId",
    "mustPresentString",
    "getMessageAttachmentMeta",
    "toCompactMessage",
  ].map((exportName) => ({
    identity: { module: "src/tool-server/tools/surface.ts", exportName },
    category: "projection" as const,
  })),
  ...[
    ["src/tools/restricted-bash.ts", "fetchNestedToolCallResponse"],
    ["src/tools/restricted-bash.ts", "createToolsCommand.defineCommand.<callback@2>.err"],
    ["src/tool-server/create-tool-server.ts", "createToolServer.post.<callback@2>@2"],
    ["src/tool-server/tools/attachment.ts", "attachmentFailureFromUnknown"],
    ["src/tool-server/tools/attachment.ts", "Attachment.callAddFiles"],
    ["src/tool-server/tools/codex.ts", "observeCodexLogin"],
    ["src/tool-server/tools/codex.ts", "Codex.runCallable"],
    ["src/tool-server/tools/content-inspect.ts", "contentInspectExternalFailure"],
    ["src/tool-server/tools/content-inspect.ts", "ContentInspect.inspect"],
    ["src/tool-server/tools/content-inspect.ts", "inspectContent"],
    ["src/tool-server/tools/content-inspect.ts", "loadInspectSource"],
    ["src/tool-server/tools/content-inspect.ts", "readInspectResponseBytes"],
    ["src/tool-server/tools/conversation-thread.ts", "conversationThreadFailure"],
    ["src/tool-server/tools/generate.ts", "readImageDataFromPath"],
    ["src/tool-server/tools/generate.ts", "resolveImageEditInputs"],
    ["src/tool-server/tools/generate.ts", "buildVideoGenerationPrompt"],
    ["src/tool-server/tools/generate.ts", "Generate.callGenerateImage"],
    ["src/tool-server/tools/generate.ts", "Generate.callGenerateVideo"],
    ["src/tool-server/tools/mcp.ts", "McpManagement.callAuth"],
    ["src/tool-server/tools/mcp.ts", "McpManagement.reconcileProviders"],
    ["src/tool-server/tools/onboarding.ts", "ensurePlaywrightChromiumInstalled"],
    ["src/tool-server/tools/onboarding.ts", "downloadToFile"],
    ["src/tool-server/tools/onboarding.ts", "fetchGithubLatestRelease"],
    ["src/tool-server/tools/onboarding.ts", "Onboarding.runCallable"],
    ["src/tool-server/tools/programmatic-workflow.ts", "ProgrammaticWorkflow.projectScope"],
    ["src/tool-server/tools/programmatic-workflow.ts", "ProgrammaticWorkflow.callTriggerCreate"],
    ["src/tool-server/tools/programmatic-workflow.ts", "ProgrammaticWorkflow.callRunTrigger"],
    ["src/tool-server/tools/skills.ts", "loadSkillsForToolHost"],
    ["src/tool-server/tools/skills.ts", "readSkillForToolHost"],
    ["src/tool-server/tools/ssh.ts", "SSH.callRun"],
    ["src/tool-server/tools/ssh.ts", "SSH.callProbe"],
    ["src/tool-server/tools/surface.ts", "surfaceExternalFailure"],
    ["src/tool-server/tools/surface.ts", "loadLocalAttachments"],
    ["src/tool-server/tools/surface.ts", "Surface.getCfg"],
    ["src/tool-server/tools/surface.ts", "Surface.resolveMessageTarget"],
    ["src/tool-server/tools/surface.ts", "Surface.callActivitiesRecentAgentWrites"],
    ["src/tool-server/tools/surface.ts", "Surface.callMessagesList"],
    ["src/tool-server/tools/surface.ts", "Surface.callMessagesRead"],
    ["src/tool-server/tools/surface.ts", "Surface.callMessagesSearch"],
    ["src/tool-server/tools/web.ts", "webFailure"],
  ].map(([module, exportName]) => ({
    identity: { module: module!, exportName: exportName! },
    category: "plugin" as const,
  })),
  {
    identity: {
      module: "src/tool-server/tools/ssh.ts",
      exportName: "readStreamText",
    },
    category: "wire",
  },
  {
    identity: {
      module: "src/tool-server/tools/ssh.ts",
      exportName: "decodeSshProbeOutput",
    },
    category: "wire",
  },
  {
    identity: {
      module: "src/tool-server/tools/web-search/firecrawl-web-search-provider.ts",
      exportName: "decodeFirecrawlSearchResponse",
    },
    category: "wire",
  },
  {
    identity: {
      module: "src/tool-server/tools/web-search/firecrawl-web-search-provider.ts",
      exportName: "decodeFirecrawlSearchItems",
    },
    category: "wire",
  },
  ...[
    "captureWebConfigFailure",
    "getNumericField",
    "getErrorStatus",
    "isRetriableWebProviderError",
  ].map((exportName) => ({
    identity: { module: "src/tool-server/tools/web.ts", exportName },
    category: "projection" as const,
  })),
  {
    identity: {
      module: "src/tool-server/tools/web/provider-page-extraction.ts",
      exportName: "decodeFirecrawlScrapeResponse",
    },
    category: "projection",
  },
  {
    identity: {
      module: "src/tool-server/tools/onboarding.ts",
      exportName: "decodeGithubReleaseResponse",
    },
    category: "wire",
  },
  {
    identity: {
      module: "src/tool-server/tools/onboarding.ts",
      exportName: "decodeGithubInstallationRepositoriesCount",
    },
    category: "wire",
  },
  ...["previewReason", "createToolServerHealthState.recordUnhandledRejection"].map(
    (exportName) => ({
      identity: { module: "src/tool-server/health-state.ts", exportName },
      category: "projection" as const,
    }),
  ),
  ...[
    "parseCgroupByteLimit",
    "parseProcStatusMemory",
    "parsePressureMetrics",
    "parseSmapsRollupMemory",
  ].map((exportName) => ({
    identity: { module: "src/tool-server/runtime-diagnostics.ts", exportName },
    category: "projection" as const,
  })),
] as const satisfies readonly BoundaryDecoder[];

const INTEGRATED_BOUNDARY_DECODERS = new Map<string, readonly BoundaryDecoder[]>([
  [
    "apps/acp-controller",
    [
      {
        identity: {
          module: "external-adapters.ts",
          exportName: "projectExternalFailure",
        },
        category: "projection",
      },
      ...["decodeRunRecord", "decodeRunCancellation", "decodeSessionIndex"].map((exportName) => ({
        identity: { module: "run-store.ts", exportName },
        category: "persistence" as const,
      })),
      {
        identity: {
          module: "external-adapters.ts",
          exportName: "replaceExternalFailureMessage",
        },
        category: "projection",
      },
    ],
  ],
  [
    "apps/mini-lilac",
    [
      {
        identity: { module: "build.ts", exportName: "decodeSourcePackage" },
        category: "request",
      },
      {
        identity: {
          module: "install-local.ts",
          exportName: "decodeNpmPackOutput",
        },
        category: "wire",
      },
      {
        identity: { module: "build.ts", exportName: "signalBuildFailure" },
        category: "projection",
      },
      {
        identity: {
          module: "install-local.ts",
          exportName: "signalLocalInstallFailure",
        },
        category: "projection",
      },
    ],
  ],
  [
    "apps/tool-bridge",
    [
      ...[
        "decodeListPayload",
        "decodeCallableIdListPayload",
        "decodeToolHelpPayload",
        "decodeToolCallPayload",
        "decodeBackendVersionPayload",
        "decodeOnboardingGpgGenerate",
        "decodeOnboardingGpgExport",
        "decodeJsonText",
        "decodeJsonObject",
        "extractErrorMessage",
        "isTimeoutCause",
        "projectBridgeFailure",
      ].map((exportName) => ({
        identity: { module: "client.ts", exportName },
        category: "wire" as const,
      })),
      ...["decodeInvocationRequest"].map((exportName) => ({
        identity: { module: "launcher.ts", exportName },
        category: "wire" as const,
      })),
    ],
  ],
  [
    "packages/agent",
    [
      ...[
        "isJsonToolOutputValue",
        "isJsonToolOutputValueInner",
        "toJsonToolOutputValue",
        "invalidInputMessage",
        "consumeAtomicToolResultStream",
        "settleAtomicToolCallImpl",
        "cleanupFailedAtomicToolCall",
        "resolveAtomicToolFailureAfterCleanup",
        "finalizeSettledAtomicToolCall",
      ].map((exportName) => ({
        identity: { module: "atomic-tool-execution.ts", exportName },
        category: "projection" as const,
      })),
      ...[
        "cloneSteeringValue",
        "isClonedModelMessage",
        "recoveryToolOutput",
        "AiSdkPiAgent.executeExternalToolCall",
        "AiSdkPiAgent.finishIdleRecovery",
        "AiSdkPiAgent.runTurn",
        "AiSdkPiAgent.executeExpansionChildren",
        "extractToolCallsFromMessages",
      ].map((exportName) => ({
        identity: { module: "ai-sdk-pi-agent.ts", exportName },
        category: "projection" as const,
      })),
      ...[
        "cloneMessage.map.<callback@1>",
        "completedAssistantPrefix.map.<callback@1>",
        "recoveryCheckpointForMessages.map.<callback@1>",
      ].map((exportName) => ({
        identity: { module: "ai-sdk-pi-agent.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: {
          module: "tool-call-id-normalization.ts",
          exportName: "rewriteAssistantToolCallIds.map.<callback@1>",
        },
        category: "projection",
      },
      ...["visit", "isLikelyContextOverflowError"].map((exportName) => ({
        identity: { module: "context-overflow.ts", exportName },
        category: "projection" as const,
      })),
      ...["readOpenAIServerCompactionArtifact", "compactWithOpenAIResponsesResult"].map(
        (exportName) => ({
          identity: { module: "openai-server-compaction.ts", exportName },
          category: "plugin" as const,
        }),
      ),
      ...[
        "getString",
        "stringifyUnknown",
        "isDataUrl",
        "withoutInlineMediaPayload",
        "stringifyTextOnly",
        "estimateMessageTokens",
        "repairTranscriptForCompaction",
        "renderMessageForSummary",
        "computeOverflowRecoveryDecision",
        "isAbortError",
        "attachAutoCompaction.notifyUnknownCapability",
      ].map((exportName) => ({
        identity: { module: "auto-compaction.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: {
          module: "auto-compaction.ts",
          exportName: "cloneMessage.map.<callback@1>",
        },
        category: "projection",
      },
      {
        identity: {
          module: "openai-server-compaction.ts",
          exportName: "materializeOpenAIServerCompaction.flatMap.<callback@1>.map.<callback@1>",
        },
        category: "projection",
      },
      ...[
        "parseStrictJsonValue",
        "normalizeCanonicalValue",
        "canonicalJsonStringify",
        "fileIdentity",
        "valueIsUrlData",
        "projectResultContentItem",
        "toolOutputProjection",
        "projectFilePart",
        "projectCanonicalMessagesV1",
        "hashExecutionScopeV1",
        "isRecognizedMediaRecord",
        "safeReplayJsonStringify",
        "renderActivityGroup",
        "sanitizeReplayValue",
        "toolInputText",
        "toolOutputValueText",
        "outputText",
        "addToolResult",
        "addOrphanResult",
        "addMalformedToolActivity",
        "takeMatchingActivity",
        "applyToolResultPart",
        "applyApprovalResponsePart",
        "applyAdjacentToolPart",
        "lowerAssistantExchange",
        "preparePlainTextReplayForTarget",
      ].map((exportName) => ({
        identity: { module: "session-continuation.ts", exportName },
        category: "projection" as const,
      })),
      ...[
        "readNumber",
        "hasRetryErrorExhausted",
        "hasTransientRetryErrorExhausted",
        "hasTransientModelErrorHint",
        "isRetryableTransientModelError",
        "defaultErrorSummary",
        "createTransientModelRetryController",
      ].map((exportName) => ({
        identity: { module: "transient-model-retry.ts", exportName },
        category: "projection" as const,
      })),
    ],
  ],
  [
    "packages/mini-lilac-runtime",
    [
      {
        identity: {
          module: "src/config.ts",
          exportName: "decodeRuntimeConfig",
        },
        category: "request",
      },
      ...[
        "decodeProviderConfig",
        "decodeProviderAuth",
        "writeProviderAuthResult",
        "writeProviderAuth",
      ].map((exportName) => ({
        identity: { module: "src/providers.ts", exportName },
        category: "plugin" as const,
      })),
      ...[
        "parseModelRefResult",
        "decodeModelsDevRegistry",
        "decodeModelsDevCache",
        "decodeV1ModelsResponse",
        "modelsDevProvider",
      ].map((exportName) => ({
        identity: { module: "src/model-catalog.ts", exportName },
        category: "wire" as const,
      })),
      {
        identity: {
          module: "src/sqlite-transcript-projection.ts",
          exportName: "acceptsMiniLilacPersistedSuperJsonValue",
        },
        category: "persistence",
      },
      ...[
        "decodeMiniLilacStoreRow",
        "decodeMiniLilacStoreRows",
        "decodeStoredHistoryNavigationResult",
        "decodeStoredUIMessageChunk",
        "decodeStoredSessionSnapshot",
        "parseStoredUIMessageChunk",
        "serialize",
        "serializeStoreValueResult",
        "canonicalJsonValue",
        "canonicalCommandPayloadResult",
        "decodeCanonicalStoredCommandRequest",
        "decodeCanonicalRootPromptCommand",
        "serializeOptionalTerminalResult",
        "canonicalValuesEqual",
        "isCanonicalPrefix",
        "decodeSessionRowSnapshot",
        "decodeRunRow",
        "decodeMiniMainClaudeBindingRow",
        "decodeMiniMainClaudeAttemptRow",
        "MiniLilacSqliteStore.decodeStructuralHistoryRow",
        "MiniLilacSqliteStore.decodeStructuralHistoryRows",
        "MiniLilacSqliteStore.parseHistoryNavigationResult",
        "MiniLilacSqliteStore.saveCommandResult",
        "MiniLilacSqliteStore.saveCommandResultResult",
        "throwPrimaryAfterCleanup",
      ].map((exportName) => ({
        identity: { module: "src/sqlite-store.ts", exportName },
        category: "persistence" as const,
      })),
      ...[
        "parseSessionConfig",
        "compactionEventFor",
        "generateSubagentSessionName",
        "toolOutputDisplayValue",
        "serializedUtf8Bytes",
        "controlCommandRequest",
        "browserSafeUsage",
        "browserSafeProviderMetadata",
        "splitFinalAnswerUIMessage",
        "chunkMatchesRollback",
        "SessionActor.startPrompt.withLock.<callback@1>",
        "SessionActor.commitRunFinalization.<callback>",
        "SessionActor.handleAgentEvent",
        "SessionActor.buildAgent.decideTurnError",
        "SessionActor.buildAgent.onCompactionEnd",
        "SessionActor.appendToolResultChunk",
        "SessionActor.queueAutomaticCompaction",
        "SessionActor.steer.withLock.<callback@1>",
        "SessionActor.cancel.withLock.<callback@1>",
        "SessionActor.undo.withLock.<callback@1>",
        "SessionActor.redo.withLock.<callback@1>",
        "SessionActor.replayHistoryNavigation",
        "SessionActor.compact.withLock.<callback@1>",
        "SessionActor.runCompaction.event",
        "SessionActor.summarizeForCompaction",
        "SessionActor.updateBindings.withLock.<callback@1>",
        "SessionService.constructor",
        "SessionService.collectDelegatedRun",
        "SessionService.interruptQueuedSteering",
      ].map((exportName) => ({
        identity: { module: "src/session-service.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: {
          module: "src/session-service.ts",
          exportName: "SessionActor.interruptQueuedSteering.withLock.<callback@1>@1",
        },
        category: "persistence",
      },
      {
        identity: {
          module: "src/session-service.ts",
          exportName: "SessionActor.interruptQueuedSteering.withLock.<callback@1>@2",
        },
        category: "projection",
      },
      ...["decodeWebfetchInput", "executeWebfetchResult", "executeWebfetch"].map((exportName) => ({
        identity: { module: "src/webfetch.ts", exportName },
        category: "plugin" as const,
      })),
      {
        identity: {
          module: "src/workspace-history-store.ts",
          exportName: "WorkspaceHistoryStoreError.constructor",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/workspace-history-store.ts",
          exportName: "runWorkspaceHistoryCleanup",
        },
        category: "projection",
      },
    ],
  ],
  [
    "apps/core",
    [
      ...CORE_TOOL_SERVER_BOUNDARY_DECODERS,
      ...CORE_FINAL_BOUNDARY_IDENTITIES.map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "projection" as const,
      })),
      ...["binaryContent", "binaryContent.flatMap.<callback@1>"].map((exportName) => ({
        identity: {
          module: "src/mcp/binary-result-materializer.ts",
          exportName,
        },
        category: "projection" as const,
      })),
      ...[
        ["src/github/github-api.ts", "decodeGithubApiErrorResponse", "wire"],
        ["src/github/github-api.ts", "githubFetchJsonResult", "wire"],
        ["src/github/github-app.ts", "readGithubAppSecretResult", "persistence"],
        ["src/github/github-user-token.ts", "readGithubUserTokenSecretResult", "persistence"],
      ].map(([module, exportName, category]) => ({
        identity: { module: module!, exportName: exportName! },
        category: category as "wire" | "persistence",
      })),
      {
        identity: {
          module: "src/question/question-store.ts",
          exportName: "decodeQuestionCallRow",
        },
        category: "persistence",
      },
      ...["formatQuestionToolArgs", "createQuestionTool.execute"].map((exportName) => ({
        identity: { module: "src/tools/question.ts", exportName },
        category: "request" as const,
      })),
      ...[
        ["src/transcript/transcript-persistence-codec.ts", "normalizeStoredMessagesV1"],
        ["src/surface/bridge/agent-run-journal/index.ts", "deserialize.andThen.<callback@1>"],
        ["src/transcript/transcript-persistence-codec.ts", "decodeStoredBlobRefV1"],
        [
          "src/transcript/stored-message-materialization.ts",
          "projectResourceReadResultsForStorage",
        ],
        ["src/transcript/stored-message-materialization.ts", "projectStoredMessagesV1"],
        ["src/transcript/stored-message-materialization.ts", "decodeProviderMessageForPersistence"],
        ["src/transcript/stored-message-materialization.ts", "decodeResourceReadCallForStorage"],
        ["src/transcript/stored-message-materialization.ts", "materializeStoredMessage"],
        ["src/transcript/transcript-store.ts", "parseNormalizedCanonicalMessages"],
        [
          "src/surface/bridge/bus-agent-runner/anthropic-fallback-cache-codec.ts",
          "decodeAnthropicFallbackCacheRecord",
        ],
      ].map(([module, exportName]) => ({
        identity: { module: module!, exportName: exportName! },
        category: "persistence" as const,
      })),
      ...[
        "zodCodec.decode",
        "zodCodec.serialize",
        "zodCodec.deserialize",
        "replaceHandles",
        "collectHandles",
        "decodeStoredMessages",
        "createCoreRequestDeliveryAdmission.validateAndBuildWork",
      ].map((exportName) => ({
        identity: {
          module: "src/surface/bridge/request-delivery/core-integration.ts",
          exportName,
        },
        category: "persistence" as const,
      })),
      ...[
        "decodeJson",
        "blobHandleCodec.decode",
        "blobRefCodec.decode",
        "arrayCodec.decode",
        "decodeRequestDeliveryInputTarget",
        "decodeRequestDeliveryTerminalOutcome",
      ].map((exportName) => ({
        identity: {
          module: "src/surface/bridge/request-delivery/sqlite-store.ts",
          exportName,
        },
        category: "persistence" as const,
      })),
      ...[
        "decodeSerialized",
        "inspectBinaryData",
        "inspectToolResult",
        "inspectLegacyMessages",
        "inspectTranscriptRow",
        "findDataUrl",
        "inspectProjectionRow",
        "canonicalizeJson",
        "inspectLineageRow",
        "preflightUnsafe",
        "decodeBinaryPayload",
        "migrateToolOutput",
        "migrateMessages",
        "rewriteProjectionDigests",
        "stageMigrationArtifacts",
      ].map((exportName) => ({
        identity: {
          module: "scripts/legacy-transcript-blob-migration.ts",
          exportName,
        },
        category: "persistence" as const,
      })),
      {
        identity: {
          module: "scripts/blob-migration-target.ts",
          exportName: "decodeCoreConfig",
        },
        category: "persistence",
      },
      {
        identity: {
          module: "scripts/legacy-graceful-restart-blob-migration.ts",
          exportName: "decodeFormerGracefulRestartSnapshot",
        },
        category: "persistence",
      },
      {
        identity: {
          module: "scripts/legacy-graceful-restart-blob-migration.ts",
          exportName: "preflightUnsafe",
        },
        category: "persistence",
      },
      {
        identity: {
          module: "scripts/legacy-graceful-restart-blob-migration.ts",
          exportName: "decodeGracefulRestartMigrationRow",
        },
        category: "persistence",
      },
      ...["decodeLimits", "isWorkflowArtifactId"].map((exportName) => ({
        identity: {
          module: "scripts/legacy-workflow-blob-migration.ts",
          exportName,
        },
        category: "persistence" as const,
      })),
      ...[
        ["scripts/legacy-workflow-blob-migration.ts", "capturedFailure"],
        ["scripts/legacy-workflow-blob-migration.ts", "inspectLegacyDirectory"],
        ["scripts/legacy-workflow-blob-migration.ts", "readLegacyArtifact"],
        ["scripts/legacy-workflow-blob-migration.ts", "blobErrorCode"],
        ["scripts/legacy-workflow-blob-migration.ts", "removeLegacyDirectory"],
        ["scripts/migrate-blob-storage.ts", "classifyCapturedOperationFailure"],
        ["scripts/migrate-blob-storage.ts", "captureOperation"],
        ["scripts/legacy-transient-blob-state.ts", "inspectRoot.catch@1"],
        ["scripts/legacy-transient-blob-state.ts", "inspectRoot.catch@2"],
      ].map(([module, exportName]) => ({
        identity: { module: module!, exportName: exportName! },
        category: "projection" as const,
      })),
      {
        identity: {
          module: "src/surface/bridge/request-delivery/core-integration.ts",
          exportName: "refine.<callback@1>@3",
        },
        category: "request",
      },
      {
        identity: {
          module: "src/surface/bridge/request-delivery/core-integration.ts",
          exportName: "createRequestDeliveryPostCommitObserver.observe",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/surface/bridge/request-delivery/core-integration.ts",
          exportName: "corePreparedEnvelopeFromCommand",
        },
        category: "request",
      },
      {
        identity: {
          module: "src/surface/bridge/request-delivery/durable-request-bus.ts",
          exportName: "createDurableCoreRequestBus.bus.publish",
        },
        category: "request",
      },
      ...[
        [
          "src/surface/bridge/bus-agent-runner/core-named-continuation.ts",
          "decodeStoredContinuationModelMessages",
          "persistence",
        ],
        ["src/surface/store/discord-search-store.ts", "decodeCachedBlobReference", "persistence"],
        [
          "src/surface/bridge/request-composition/prepare-bus-messages.ts",
          "preparePart",
          "request",
        ],
        [
          "src/surface/bridge/request-composition/prepare-bus-messages.ts",
          "prepareMessage",
          "request",
        ],
        [
          "src/surface/bridge/request-composition.ts",
          "composeSelectedDiscordChain.<callback>@2",
          "request",
        ],
      ].map(([module, exportName, category]) => ({
        identity: { module: module!, exportName: exportName! },
        category: category as "persistence" | "request",
      })),
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "decodeToolRequestHeaders",
        },
        category: "request",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "decodeToolPayload",
        },
        category: "plugin",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "projectUnhandledRejectionReason",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "createToolServer.recordUnhandledRejectionAtBoundary",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "projectFatalToolCallDefect",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "normalizeSuccessfulToolValue",
        },
        category: "plugin",
      },
      {
        identity: {
          module: "src/surface/authenticated-request.ts",
          exportName: "projectAuthenticatedRequest",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/tool-server/request-message-cache.ts",
          exportName: "projectCachedRequestMessageLineage",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/conversation/thread-summarization-worker-protocol.ts",
          exportName: "decodeThreadSummarizationWorkerRequest",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/conversation/thread-summarization-worker-protocol.ts",
          exportName: "decodeThreadSummarizationWorkerResponse",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/conversation/thread-summarization-worker-protocol.ts",
          exportName: "decodeThreadSummarizationParentMessage",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/conversation/thread-summarization-worker-protocol.ts",
          exportName: "decodeThreadSummarizationWorkerMessage",
        },
        category: "wire",
      },
    ],
  ],
  [
    "packages/coding-tools",
    [
      ...[
        "createFilesystemTools.toModelOutput@1",
        "createFilesystemTools.toModelOutput@2",
        "createFilesystemTools.toModelOutput@3",
        "createFilesystemTools.toModelOutput@4",
      ].map((exportName) => ({
        identity: { module: "src/filesystem.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: {
          module: "src/batch.ts",
          exportName: "decodeBatchEditInput",
        },
        category: "plugin",
      },
      {
        identity: { module: "src/batch.ts", exportName: "validateInput" },
        category: "plugin",
      },
      {
        identity: {
          module: "src/batch.ts",
          exportName: "resolveBatchEditTargets",
        },
        category: "plugin",
      },
      {
        identity: {
          module: "src/instructions.ts",
          exportName: "decodePreviouslyLoadedInstructionPaths",
        },
        category: "projection",
      },
      {
        identity: { module: "src/bash.ts", exportName: "bashFailureMessage" },
        category: "projection",
      },
    ],
  ],
  [
    "packages/event-bus",
    [
      ...[
        "decodeBeginFreshResponse",
        "decodeBeginInvocationResponse",
        "decodeHeartbeatResponse",
        "decodeCommitResponse",
        "decodeScheduleRetryResponse",
        "decodeParkResponse",
        "decodeClaimRecoverableResponse",
        "decodeBeginTerminalResponse",
        "decodeStageTerminalResponse",
        "decodeFinalizeTerminalResponse",
        "decodeStateCleanupScanResponse",
        "decodeStateCleanupDeleteResponse",
      ].map((exportName) => ({
        identity: { module: "redis-managed-delivery/responses.ts", exportName },
        category: "wire" as const,
      })),
      {
        identity: {
          module: "redis-managed-delivery/responses.ts",
          exportName: "transform.<callback@1>@5",
        },
        category: "wire",
      },
      {
        identity: {
          module: "redis-streams-bus.ts",
          exportName: "deliveryAction",
        },
        category: "request",
      },
      {
        identity: {
          module: "redis-streams-bus.ts",
          exportName: "decodeRedisReadResponse",
        },
        category: "wire",
      },
      {
        identity: {
          module: "redis-streams-bus.ts",
          exportName: "decodeRedisWatermarkResponse",
        },
        category: "wire",
      },
      {
        identity: {
          module: "redis-streams-bus.ts",
          exportName: "decodeRedisPendingSummary",
        },
        category: "wire",
      },
      {
        identity: {
          module: "redis-streams-bus.ts",
          exportName: "decodeRedisOldestPendingIdle",
        },
        category: "wire",
      },
      {
        identity: {
          module: "redis-streams-bus.ts",
          exportName: "decodeRedisRangeResponse",
        },
        category: "wire",
      },
      {
        identity: {
          module: "redis-streams-bus.ts",
          exportName: "decodeRedisCleanupPendingPresence",
        },
        category: "wire",
      },
      {
        identity: {
          module: "redis-event-dead-letter.ts",
          exportName: "decodeRedisDeadLetterEvidenceEntry",
        },
        category: "persistence",
      },
      {
        identity: {
          module: "redis-event-dead-letter.ts",
          exportName: "decodeRedisDeadLetterTransactionId",
        },
        category: "persistence",
      },
      {
        identity: {
          module: "redis-event-dead-letter.ts",
          exportName: "decodeRedisDeadLetterTime",
        },
        category: "persistence",
      },
      {
        identity: {
          module: "redis-event-dead-letter.ts",
          exportName: "decodeEventDeadLetterRecord",
        },
        category: "persistence",
      },
      ...["transform.<callback@1>@3", "custom.<callback@1>"].map((exportName) => ({
        identity: { module: "redis-event-dead-letter.ts", exportName },
        category: "persistence" as const,
      })),
    ],
  ],
  [
    "apps/mini-lilac-tui",
    [
      {
        identity: {
          module: "src/opentui-boundary.ts",
          exportName: "decodeDraftExtmarkData",
        },
        category: "plugin",
      },
      {
        identity: {
          module: "src/preferences.ts",
          exportName: "decodeBindingPreferences",
        },
        category: "persistence",
      },
      {
        identity: {
          module: "src/ui-message-chunk-projection.ts",
          exportName: "projectMiniLilacStreamChunk",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/terminal-runtime-adapter.ts",
          exportName: "resolveTerminalShutdownOutcome",
        },
        category: "projection",
      },
      ...[
        "parseInput",
        "decodeBash",
        "decodeEditFile",
        "decodeSubagentDelegate",
        "decodeWebsearch",
        "projectToolObservation",
      ].map((exportName) => ({
        identity: { module: "src/tool-observation-projection.ts", exportName },
        category: "projection" as const,
      })),
      ...["observationFromCanonicalPart", "UIMessageChunkProjectionState.toolChunk"].map(
        (exportName) => ({
          identity: { module: "src/ui-message-chunk-projection.ts", exportName },
          category: "projection" as const,
        }),
      ),
    ],
  ],
  [
    "apps/mini-lilac-server",
    [
      ...["decodeMiniLilacHttpRequest", "decodeMiniLilacUiMessages"].map((exportName) => ({
        identity: { module: "src/server.ts", exportName },
        category: "request" as const,
      })),
      {
        identity: {
          module: "src/main.ts",
          exportName: "decodeMiniLilacCliOptions",
        },
        category: "request",
      },
      {
        identity: { module: "src/main.ts", exportName: "parseCliArgs" },
        category: "request",
      },
      {
        identity: {
          module: "src/server.ts",
          exportName: "adaptMiniLilacPersistenceResult",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/server.ts",
          exportName: "classifyHttpOperationFailure",
        },
        category: "projection",
      },
    ],
  ],
  [
    "packages/mini-lilac-client",
    [
      {
        identity: {
          module: "mini-lilac-transport.ts",
          exportName: "decodeMiniLilacBoundary",
        },
        category: "wire",
      },
      {
        identity: {
          module: "mini-lilac-transport.ts",
          exportName: "resultToMiniLilacClientValue",
        },
        category: "projection",
      },
      {
        identity: {
          module: "mini-lilac-transport.ts",
          exportName: "resultToMiniLilacCompatibilityFailure",
        },
        category: "projection",
      },
      {
        identity: {
          module: "mini-lilac-transport.ts",
          exportName: "normalizeStreamChunkResult",
        },
        category: "wire",
      },
    ],
  ],
  [
    "packages/claude-code-bridge",
    [
      ...[
        "decodeClaudeNativeSessionStart",
        "decodeClaudeContextUsage",
        "decodeClaudeStopHookInput",
        "decodeClaudeSessionInfo",
        "projectClaudeSdkMessage",
        "materializeClaudeCodeRunResult.observeSdkMessage",
      ].map((exportName) => ({
        identity: { module: "claude-code-run.ts", exportName },
        category: "plugin" as const,
      })),
      {
        identity: {
          module: "claude-code-tools.ts",
          exportName: "createClaudeCodeToolBridgeResult",
        },
        category: "plugin",
      },
      {
        identity: {
          module: "claude-code-run.ts",
          exportName: "readSessionInfo",
        },
        category: "plugin",
      },
      {
        identity: {
          module: "claude-code-run.ts",
          exportName: "materializeClaudeCodeRunResult.beginContextCapture.<callback>",
        },
        category: "plugin",
      },
      {
        identity: {
          module: "claude-code-run.ts",
          exportName: "boundedExternalFailure",
        },
        category: "projection",
      },
      {
        identity: {
          module: "claude-code-tools.ts",
          exportName: "mapToolResultOutputToMcpResult",
        },
        category: "projection",
      },
    ],
  ],
  [
    "packages/fs",
    [
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeJson",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeRequest",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeBundledRemoteRunnerRequest",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeRemoteFsRequest",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeRemoteFsDaemonRequest",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeRemoteRunnerResponse",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeRemoteRunnerResponseValue",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/filesystem-operation.ts",
          exportName: "decodeFilesystemFailure",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/ripgrep.ts",
          exportName: "decodeRipgrepMatchLine",
        },
        category: "wire",
      },
    ],
  ],
  [
    "packages/remote-fs-runner",
    [
      {
        identity: { module: "src/cli.ts", exportName: "opaqueErrorCause" },
        category: "projection",
      },
    ],
  ],
  [
    "packages/plugin-runtime",
    [
      ...[
        "validateToolPluginMetaCapability",
        "validateLevel1ToolSpecCapability",
        "validateServerToolCapability",
        "validateToolPluginInstanceCapability",
        "validateToolPluginCapability",
        "validateDynamicToolPluginModuleCapability",
        "validateServerToolListResultCapability",
        "validateLevel1ToolFailureSummaryCapability",
        "decodeDynamicToolPluginModule",
        "decodeToolPlugin",
        "decodeToolPluginInstance",
        "decodeLevel1ToolSpec",
        "decodeServerTool",
        "decodeVoidHookResult",
        "decodeBooleanHookResult",
        "decodeStringHookResult",
        "decodeStringArrayHookResult",
        "decodeServerToolListResult",
        "decodeLevel1ToolFailureSummary",
        "decodeLevel1ExecutableMetadata",
        "decodeDisabledPluginIds",
        "decodeLevel1RegistrationKey",
      ].map((exportName) => ({
        identity: { module: "capabilities.ts", exportName },
        category: "plugin" as const,
      })),
      {
        identity: {
          module: "discovery.ts",
          exportName: "decodePluginFilesystemErrorCode",
        },
        category: "projection",
      },
      {
        identity: {
          module: "discovery.ts",
          exportName: "decodePluginPackageJsonText",
        },
        category: "plugin",
      },
      {
        identity: {
          module: "server-tool-result.ts",
          exportName: "decodeServerToolResult",
        },
        category: "plugin",
      },
      ...["transform.<callback@1>@1", "transform.<callback@1>@2"].map((exportName) => ({
        identity: { module: "server-tool-result.ts", exportName },
        category: "plugin" as const,
      })),
    ],
  ],
  [
    "packages/utils",
    [
      {
        identity: {
          module: "custom-commands.ts",
          exportName: "decodeCustomCommandResult",
        },
        category: "plugin",
      },
      {
        identity: {
          module: "custom-commands.ts",
          exportName: "readCustomCommandDefinition",
        },
        category: "plugin",
      },
      {
        identity: {
          module: "agent-prompts.ts",
          exportName: "parsePromptTemplateState",
        },
        category: "persistence",
      },
      {
        identity: {
          module: "ai-error.ts",
          exportName: "parseProviderErrorDetails",
        },
        category: "projection",
      },
      {
        identity: { module: "ai-error.ts", exportName: "locateAiErrors" },
        category: "projection",
      },
      {
        identity: {
          module: "ai-error.ts",
          exportName: "extractAiErrorLogDetails",
        },
        category: "projection",
      },
      ...["readString", "readStringOrNumber"].map((exportName) => ({
        identity: { module: "ai-error.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: { module: "build-info.ts", exportName: "decodeBuildInfo" },
        category: "persistence",
      },
      {
        identity: { module: "codex-oauth.ts", exportName: "parseJwtClaims" },
        category: "wire",
      },
      {
        identity: {
          module: "codex-oauth.ts",
          exportName: "extractAccountIdFromClaims",
        },
        category: "wire",
      },
      ...[
        "decodeCodexTokens",
        "writeCodexTokensResult",
        "exchangeCodeForTokensResult",
        "refreshAccessTokenResult",
      ].map((exportName) => ({
        identity: { module: "codex-oauth.ts", exportName },
        category: "wire" as const,
      })),
      ...[
        "projectLegacyCodexTokenWriteFailure",
        "projectLegacyCodexOAuthFailure",
        "projectLegacyCodexOAuthLoginFailure",
        "readCodexTokens",
        "clearCodexTokens",
      ].map((exportName) => ({
        identity: { module: "codex-oauth.ts", exportName },
        category: "projection" as const,
      })),
      ...[
        "readCoreConfigVersionResult",
        "readCoreConfigVersion",
        "parseCoreConfigResult",
        "parseCoreConfig",
        "getCoreConfig",
      ].map((exportName) => ({
        identity: { module: "core-config.ts", exportName },
        category: "request" as const,
      })),
      {
        identity: {
          module: "core-config.ts",
          exportName: "projectLegacyCoreConfigFailure",
        },
        category: "projection",
      },
      ...[
        ["core-config/v1.ts", "decodeCoreConfigV1"],
        ["core-config/v1.ts", "parseCoreConfigV1"],
        ["core-config/v1.ts", "coreConfigV1ToUniversal"],
        ["core-config/v1.ts", "decodeCoreConfigV1ToUniversal"],
        ["core-config/v1.ts", "parseCoreConfigV1ToUniversal"],
        ["core-config/v2.ts", "decodeCoreConfigV2"],
        ["core-config/v2.ts", "parseCoreConfigV2"],
        ["core-config/v2.ts", "coreConfigV2ToUniversal"],
        ["core-config/v2.ts", "decodeCoreConfigV2ToUniversal"],
        ["core-config/v2.ts", "parseCoreConfigV2ToUniversal"],
      ].map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "request" as const,
      })),
      {
        identity: {
          module: "core-config/unknown-keys.ts",
          exportName: "collectUnknownConfigKeyPaths",
        },
        category: "projection",
      },
      ...["migrateWebExtractConfigValue", "migrateWebConfigValue"].map((exportName) => ({
        identity: { module: "core-config/v1.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: {
          module: "model-capability.ts",
          exportName: "decodeModelsDevRegistry",
        },
        category: "wire",
      },
      {
        identity: {
          module: "model-capability.ts",
          exportName: "ModelCapability.resolve",
        },
        category: "projection",
      },
      {
        identity: {
          module: "model-capability.ts",
          exportName: "ModelCapability.loadRegistryResult.<callback>",
        },
        category: "wire",
      },
      ...["openAIMessagePhase", "decodeOpenAICompactionPart"].map((exportName) => ({
        identity: { module: "model-message-provider-options.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: {
          module: "model-message-provider-options.ts",
          exportName: "withoutOpenAIItemIds.map.<callback@1>.map.<callback@1>",
        },
        category: "projection",
      },
      ...[
        ["decodeCodexRequestBody", "request"],
        ["decodeCodexResponsesRequestBody", "request"],
        ["normalizeCodexResponsesRequestRecordResult", "request"],
        ["codexReasoningSummaryKey", "projection"],
        ["normalizeCodexCompactionItemId", "projection"],
        ["createCodexResponsesEventNormalizer.<callback>", "projection"],
      ].map(([exportName, category]) => ({
        identity: { module: "model-provider.ts", exportName },
        category: category as BoundaryCategory,
      })),
      ...[
        "asRecord",
        "readString",
        "readNumber",
        "extractResponseId",
        "extractTurnState",
        "extractOutputItemDone",
        "updateOutputItemDraft",
        "normalizeReplayMessageItem.map.<callback@1>",
        "normalizeReplayReasoningItem.map.<callback@1>",
        "normalizeResponsesFailureEvent",
        "normalizeErrorEventShape",
        "isPreviousResponseNotFoundError",
        "extractErrorDetails",
        "readHeaderValue",
        "projectResponsesStreamError",
        "projectResponsesEvent",
      ].map((exportName) => ({
        identity: { module: "openai-responses-websocket-fetch.ts", exportName },
        category: "projection" as const,
      })),
      ...["createOpenAIResponsesWebSocketFetch.reportAutoFallback", "captureResponsesFailure"].map(
        (exportName) => ({
          identity: { module: "openai-responses-websocket-fetch.ts", exportName },
          category: "projection" as const,
        }),
      ),
      ...[
        "parseFriendlyUnitResult",
        "parseFriendlyByteSizeResult",
        "parseFriendlyDurationMsResult",
        "parseFriendlyByteSize",
        "parseFriendlyDurationMs",
      ].map((exportName) => ({
        identity: { module: "friendly-units.ts", exportName },
        category: "request" as const,
      })),
      ...[
        "addNormalizedArgFields",
        "normalizeRecordForOpenObserve",
        "captureOpenObserveRequestFailure",
        "signalOpenObservePanic",
      ].map((exportName) => ({
        identity: { module: "logging.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: { module: "llm-wire-debug.ts", exportName: "redactValue" },
        category: "projection",
      },
      {
        identity: {
          module: "llm-wire-debug.ts",
          exportName: "projectWireDebugEventType",
        },
        category: "projection",
      },
      {
        identity: {
          module: "llm-wire-debug.ts",
          exportName: "createWriter.<callback>",
        },
        category: "projection",
      },
      ...["errorMessage", "errorCode"].map((exportName) => ({
        identity: { module: "runtime-utils.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: {
          module: "server-compaction-request.ts",
          exportName: "isServerCompactionTrigger",
        },
        category: "request",
      },
      {
        identity: {
          module: "openai-responses-websocket-fetch.ts",
          exportName: "decodeResponsesRequestBody",
        },
        category: "request",
      },
      {
        identity: {
          module: "server-compaction-request.ts",
          exportName: "decodeServerCompactionPayload",
        },
        category: "request",
      },
      {
        identity: {
          module: "server-compaction-request.ts",
          exportName: "prepareServerCompactionRequestResult",
        },
        category: "request",
      },
      {
        identity: {
          module: "server-compaction-request.ts",
          exportName: "withServerCompactionRequestFetch.wrappedFetch",
        },
        category: "projection",
      },
      {
        identity: {
          module: "server-compaction-request.ts",
          exportName: "encodeServerCompactionPayload.filter.<callback@1>",
        },
        category: "request",
      },
      {
        identity: {
          module: "server-compaction-request.ts",
          exportName: "encodeServerCompactionPayload",
        },
        category: "request",
      },
      {
        identity: {
          module: "skills.ts",
          exportName: "parseSkillMarkdownResult",
        },
        category: "plugin",
      },
      ...[
        "normalizeToolCallInputValue",
        "normalizeAssistantToolCallInputMessage.map.<callback@1>",
      ].map((exportName) => ({
        identity: { module: "tool-call-input-normalization.ts", exportName },
        category: "projection" as const,
      })),
    ],
  ],
]);

const INTEGRATED_OPAQUE_UNKNOWN = new Map<string, readonly ReasonedSymbolException[]>([
  [
    "apps/acp-controller",
    [
      {
        identity: {
          module: "external-adapters.ts",
          exportName: "replaceExternalFailureMessage",
        },
        reason: "Carries the already-owned external failure cause without reinterpreting it.",
      },
    ],
  ],
  [
    "apps/tool-bridge",
    [
      {
        identity: { module: "client.ts", exportName: "reportMainDefect" },
        reason: "Classifies an opaque top-level CLI defect only for bounded process reporting.",
      },
      {
        identity: {
          module: "index.ts",
          exportName: "recordUnhandledRejection",
        },
        reason: "Carries the process rejection reason opaquely to the Core server supervisor.",
      },
    ],
  ],
  [
    "packages/agent",
    [
      {
        identity: {
          module: "ai-sdk-pi-agent.ts",
          exportName: "AiSdkPiAgent.requestIdleRecovery",
        },
        reason:
          "Carries the model provider's idle failure opaquely to the configured retry policy.",
      },
      {
        identity: {
          module: "auto-compaction.ts",
          exportName: "compactCanonicalMessages",
        },
        reason:
          "Carries a server-compaction callback failure opaquely to the caller-owned observer.",
      },
    ],
  ],
  [
    "packages/mini-lilac-runtime",
    [
      {
        identity: {
          module: "src/session-service.ts",
          exportName: "sha256Fingerprint",
        },
        reason:
          "Serializes an opaque provider-owned value only to derive a stable content fingerprint.",
      },
      {
        identity: {
          module: "src/workspace-history-store.ts",
          exportName: "WorkspaceHistoryStore.withWorkspaceLock",
        },
        reason:
          "Carries a supervised defect opaquely through the public legacy lock host contract.",
      },
      {
        identity: {
          module: "src/session-service.ts",
          exportName: "rethrowSessionPanic",
        },
        reason: "Observes an opaque failure only to preserve Panic identity.",
      },
      {
        identity: {
          module: "src/session-service.ts",
          exportName: "SessionActor.reportEventFailure",
        },
        reason: "Carries an opaque agent event failure to bounded diagnostics and cancellation.",
      },
    ],
  ],
  [
    "apps/core",
    [
      ...CORE_FINAL_REVIEWED_OPAQUE_IDENTITIES.map(([module, exportName]) => ({
        identity: { module, exportName },
        reason:
          "Carries an opaque external cause through an exact error, callback, or function contract without interpreting it as domain data.",
      })),
      {
        identity: {
          module: "src/runtime/create-core-runtime.ts",
          exportName: "createCoreRuntimeCleanupSupervisor.runOutcome",
        },
        reason:
          "Carries an owned cleanup Result error opaquely to the runtime diagnostic formatter.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner/raw.ts",
          exportName: "preserveAgentRunnerRaw",
        },
        reason: "Preserves a decoded event raw payload opaquely for downstream boundary adapters.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner/formatting.ts",
          exportName: "safeStringify",
        },
        reason: "Serializes an opaque diagnostic value without interpreting domain structure.",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "createToolServer.<callback>.<callback>",
        },
        reason:
          "Carries decoded plugin tool output opaquely to the established tool response envelope.",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "createToolServer.<callback>",
        },
        reason:
          "Carries settled plugin tool output opaquely through the established HTTP wire contract.",
      },
      {
        identity: { module: "src/tools/batch.ts", exportName: "batchTool" },
        reason: "Carries an AI SDK tool-call payload opaquely to the selected child tool boundary.",
      },
      {
        identity: {
          module: "src/plugins/manager.ts",
          exportName:
            "createCoreToolPluginManager.buildLevel1Toolset.buildContext.resolveEditTargets",
        },
        reason: "Carries opaque external plugin arguments to the plugin-owned editTargets hook.",
      },
    ],
  ],
  [
    "packages/coding-tools",
    [
      {
        identity: { module: "src/batch.ts", exportName: "createBatchTool" },
        reason: "Carries an AI SDK tool-call payload opaquely to the selected child tool boundary.",
      },
      {
        identity: {
          module: "src/batch.ts",
          exportName: "createBatchToolResult",
        },
        reason: "Carries an AI SDK tool-call payload opaquely to the selected child tool boundary.",
      },
    ],
  ],
  [
    "packages/claude-code-bridge",
    [
      {
        identity: {
          module: "claude-code-run.ts",
          exportName: "ClaudeCodeRunModelSettings.onSdkMessage",
        },
        reason:
          "Carries the SDK callback value opaquely to the registered Claude message projector and optional observer.",
      },
      {
        identity: {
          module: "claude-code-tools.ts",
          exportName: "stringifyJson",
        },
        reason: "Serializes plugin-owned tool output without interpreting its domain structure.",
      },
      {
        identity: {
          module: "claude-code-run.ts",
          exportName: "boundedExternalFailure",
        },
        reason: "Bounds an opaque external failure cause for a callback-safe diagnostic.",
      },
    ],
  ],
  [
    "packages/plugin-runtime",
    [
      {
        identity: { module: "zod-cli.ts", exportName: "formatValue" },
        reason: "Formats generic Zod literal and default values without interpreting domain data.",
      },
      {
        identity: {
          module: "capabilities.ts",
          exportName: "opaquePluginExceptionMessage",
        },
        reason: "Formats an opaque plugin exception without treating it as domain data.",
      },
      {
        identity: {
          module: "capabilities.ts",
          exportName: "safePluginExceptionCause",
        },
        reason: "Projects an opaque plugin exception into a safe plain Error cause.",
      },
      {
        identity: {
          module: "discovery.ts",
          exportName: "opaquePluginDiscoveryExceptionMessage",
        },
        reason: "Formats an opaque filesystem exception without treating it as domain data.",
      },
      {
        identity: {
          module: "types.ts",
          exportName: "Level1ToolBuildContext.resolveEditTargets",
        },
        reason:
          "Public plugin compatibility contract carries tool arguments opaquely to the owning plugin.",
      },
      {
        identity: {
          module: "types.ts",
          exportName: "Level1ToolSpec.editTargets",
        },
        reason: "Public plugin hook receives its plugin-owned tool argument shape opaquely.",
      },
      {
        identity: {
          module: "types.ts",
          exportName: "Level1ToolSpec.formatArgs",
        },
        reason: "Public plugin hook formats its plugin-owned tool argument shape opaquely.",
      },
      {
        identity: {
          module: "types.ts",
          exportName: "Level1ToolSpec.summarizeFailure",
        },
        reason:
          "Public plugin hook receives the host tool result as an opaque compatibility value.",
      },
      {
        identity: {
          module: "manager.ts",
          exportName: "ToolPluginManagerOptions.getPluginConfig",
        },
        reason:
          "Public plugin configuration remains opaque until the selected plugin interprets it.",
      },
    ],
  ],
  [
    "packages/utils",
    [
      {
        identity: {
          module: "runtime-utils.ts",
          exportName: "opaqueErrorMessage",
        },
        reason: "Formats an opaque external exception without interpreting domain data.",
      },
      {
        identity: {
          module: "runtime-utils.ts",
          exportName: "opaqueErrorCause",
        },
        reason: "Carries an inspectable exception cause or substitutes a plain opaque Error.",
      },
      {
        identity: {
          module: "codex-oauth.ts",
          exportName: "startCodexOAuthLogin.fail",
        },
        reason: "Carries an opaque callback-server failure to the established Promise rejection.",
      },
      {
        identity: { module: "logging.ts", exportName: "isPrimitive" },
        reason: "Checks generic logger values without interpreting application domain data.",
      },
      {
        identity: { module: "logging.ts", exportName: "safeJsonStringify" },
        reason: "Serializes generic logger values without interpreting application domain data.",
      },
      {
        identity: {
          module: "logging.ts",
          exportName: "addNormalizedArgFields",
        },
        reason: "Projects generic logger arguments into bounded structured fields.",
      },
      {
        identity: {
          module: "logging.ts",
          exportName: "normalizeRecordForOpenObserve",
        },
        reason: "Projects a generic logger record into the OpenObserve transport shape.",
      },
      {
        identity: { module: "llm-wire-debug.ts", exportName: "redactValue" },
        reason: "Redacts generic wire-debug values without interpreting application domain data.",
      },
      ...[
        "MirroredLogger.log",
        "MirroredLogger.logDebug",
        "MirroredLogger.logInfo",
        "MirroredLogger.logWarn",
        "MirroredLogger.logError",
        "MirroredLogger.logFatal",
        "MirroredLogger.debug",
        "MirroredLogger.info",
        "MirroredLogger.warn",
        "MirroredLogger.error",
        "MirroredLogger.fatal",
      ].map((exportName) => ({
        identity: { module: "logging.ts", exportName },
        reason: "Carries logger message arguments opaquely to the registered structured sink.",
      })),
    ],
  ],
  [
    "packages/mini-lilac-client",
    [
      {
        identity: {
          module: "mini-lilac-transport.ts",
          exportName: "MiniLilacParsedStream.cleanupSource",
        },
        reason:
          "Carries the ReadableStream cancellation reason opaquely to the registered source cleanup adapter.",
      },
    ],
  ],
]);

const INTEGRATED_CAPABILITY_PREDICATES = new Map<string, readonly ReasonedSymbolException[]>([
  [
    "apps/acp-controller",
    [
      {
        identity: {
          module: "acp-harness-client.ts",
          exportName: "isAuthRequiredError",
        },
        reason:
          "Checks the exact ACP RequestError authorization code on an owned external failure.",
      },
    ],
  ],
  [
    "packages/agent",
    [
      {
        identity: { module: "failure-adapters.ts", exportName: "isAgentPanic" },
        reason: "Checks exact Panic identity without interpreting an ordinary failure.",
      },
      {
        identity: {
          module: "tool-call-expansion.ts",
          exportName: "isToolExpansion",
        },
        reason: "Checks the exact project-owned ToolExpansion class and brand.",
      },
      {
        identity: {
          module: "atomic-tool-execution.ts",
          exportName: "isAsyncIterable",
        },
        reason: "Checks only the standard async-iterator capability on tool output.",
      },
      {
        identity: {
          module: "atomic-tool-execution.ts",
          exportName: "isInvalidToolInputError",
        },
        reason: "Checks exact AI SDK, Zod, and owned invalid-input error identities.",
      },
      {
        identity: {
          module: "atomic-tool-execution.ts",
          exportName: "isJsonToolOutputValue",
        },
        reason:
          "Checks complete recursive JSON output representability, including finite numbers and cycles.",
      },
      {
        identity: {
          module: "atomic-tool-execution.ts",
          exportName: "isJsonToolOutputValueInner",
        },
        reason:
          "Performs the recursive JSON output representability check with explicit cycle tracking.",
      },
      {
        identity: {
          module: "ai-sdk-pi-agent.ts",
          exportName: "isClonedModelMessage",
        },
        reason:
          "Checks the closed model-message role capability after the structure-preserving clone.",
      },
    ],
  ],
  [
    "packages/mini-lilac-runtime",
    [
      {
        identity: {
          module: "src/sqlite-transcript-projection.ts",
          exportName: "acceptsMiniLilacPersistedSuperJsonValue",
        },
        reason:
          "Checks only whether a persisted opaque value survives the exact SuperJSON representation round trip.",
      },
      {
        identity: {
          module: "src/workspace-history-store.ts",
          exportName: "isMissingExecutable",
        },
        reason:
          "Checks only the exact Node filesystem ENOENT capability on an opaque process failure.",
      },
    ],
  ],
  [
    "packages/plugin-runtime",
    ["isFunctionCapability", "isPluginPanic"].map((exportName) => ({
      identity: { module: "capabilities.ts", exportName },
      reason: "Checks one exact runtime capability without interpreting plugin-owned domain data.",
    })),
  ],
  [
    "apps/core",
    [
      ...CORE_FINAL_CAPABILITY_IDENTITIES.map(([module, exportName]) => ({
        identity: { module, exportName },
        reason:
          "Checks one exact external capability, discriminant, brand, or bounded protocol condition without projecting domain data.",
      })),
      ...["hasGuildIdResolver", "hasReactionDetailsProvider", "hasSessionParticipantsProvider"].map(
        (exportName) => ({
          identity: { module: "src/tool-server/tools/surface.ts", exportName },
          reason: "Checks one exact optional SurfaceAdapter method capability.",
        }),
      ),
      {
        identity: {
          module: "src/tool-server/tools/generate.ts",
          exportName: "writeFileWithUniqueName",
        },
        reason: "Checks the exact Node filesystem EEXIST code before retrying a unique filename.",
      },
    ],
  ],
  [
    "packages/utils",
    [
      {
        identity: { module: "runtime-utils.ts", exportName: "isPanic" },
        reason:
          "Checks exact Panic identity while treating hostile classifier inspection as ordinary opaque failure.",
      },
      {
        identity: { module: "runtime-utils.ts", exportName: "isRecord" },
        reason: "Checks only the exact plain record capability used by boundary projections.",
      },
      {
        identity: {
          module: "model-message-provider-options.ts",
          exportName: "isOpenAICompactionPart",
        },
        reason: "Delegates to the complete OpenAI compaction-part schema decoder.",
      },
      {
        identity: {
          module: "subagent-profile.ts",
          exportName: "isNativeSubagentProfile",
        },
        reason:
          "Checks the closed native subagent profile literals without projecting richer data.",
      },
    ],
  ],
]);

const INTEGRATED_OPEN_PROTOCOL_ADAPTERS = new Map<string, readonly OpenProtocolAdapter[]>([
  [
    "packages/agent",
    [
      {
        identity: {
          module: "ai-sdk-pi-agent.ts",
          exportName: "projectAiSdkTextStreamPart",
        },
        externalProtocol: { package: "ai", exportName: "TextStreamPart" },
        protocolParameter: 0,
        fallbackVariant: { discriminant: "kind", value: "unsupported" },
        reason:
          "Projects generic AI SDK TextStreamPart tool instantiations into a closed agent stream union.",
      },
    ],
  ],
  [
    "apps/acp-controller",
    [
      {
        identity: {
          module: "session-history.ts",
          exportName: "projectSessionUpdate",
        },
        externalProtocol: {
          package: "@agentclientprotocol/sdk",
          exportName: "SessionUpdate",
        },
        protocolParameter: 0,
        fallbackVariant: { discriminant: "type", value: "unsupported" },
        reason:
          "Defense-in-depth projection for runtime ACP version skew; the SDK normally validates SessionUpdate before this adapter runs.",
      },
    ],
  ],
  [
    "apps/mini-lilac-tui",
    [
      {
        identity: {
          module: "src/ui-message-chunk-projection.ts",
          exportName: "projectUIMessageChunk",
        },
        externalProtocol: { package: "ai", exportName: "UIMessageChunk" },
        protocolParameter: 0,
        fallbackVariant: { discriminant: "kind", value: "unsupported" },
        reason: "Projects the open AI SDK stream protocol into local TUI chunk variants.",
      },
    ],
  ],
]);

const OPEN_PROTOCOL_RULE_ZONES = new Map<string, readonly RuleZone[]>([
  ["packages/agent", [{ include: "ai-sdk-pi-agent.ts" }]],
  ["apps/acp-controller", [{ include: "session-history.ts" }]],
  ["apps/mini-lilac-tui", [{ include: "src/ui-message-chunk-projection.ts" }]],
]);

const EVENT_BUS_CODEC_REGISTRY: EventCodecRegistryRegistration = {
  identity: {
    module: "lilac-codecs.ts",
    exportName: "lilacEventCodecRegistry",
  },
  catalog: { module: "lilac-spec.ts", exportName: "LILAC_EVENTS" },
  catalogHelper: {
    module: "define-lilac-events.ts",
    exportName: "defineLilacEvents",
  },
  registryHelper: {
    module: "define-lilac-events.ts",
    exportName: "createLilacEventCodecRegistry",
  },
};

const TUI_TOOL_CODEC_REGISTRY: ToolCodecRegistryRegistration = {
  identity: {
    module: "src/tool-observation-projection.ts",
    exportName: "toolObservationCodecRegistry",
  },
  aliases: [
    {
      module: "src/tool-observation-projection.ts",
      exportName: "knownToolCodecRegistry",
    },
  ],
  canonicalTools: {
    package: "@stanley2058/mini-lilac-client",
    module: "tool-catalog.ts",
    exportName: "MINI_LILAC_TOOL_NAMES",
  },
};

const TUI_RESULT_DECODER: ResultDecoderRegistration = {
  identity: {
    module: "src/tool-observation-projection.ts",
    exportName: "decodeKnownToolObservation",
  },
  category: "projection",
  inputParameter: 0,
};

const WAVE_2_RESULT_DECODERS = new Map<string, readonly ResultDecoderRegistration[]>([
  [
    "packages/claude-code-bridge",
    [
      {
        identity: {
          module: "claude-code-run.ts",
          exportName: "decodeClaudeContextUsage",
        },
        category: "plugin",
        inputParameter: 0,
      },
      {
        identity: {
          module: "claude-code-run.ts",
          exportName: "decodeClaudeStopHookInput",
        },
        category: "plugin",
        inputParameter: 0,
      },
      {
        identity: {
          module: "claude-code-run.ts",
          exportName: "decodeClaudeSessionInfo",
        },
        category: "plugin",
        inputParameter: 0,
      },
    ],
  ],
  [
    "packages/utils",
    ["parseFriendlyByteSizeResult", "parseFriendlyDurationMsResult"].map((exportName) => ({
      identity: { module: "friendly-units.ts", exportName },
      category: "request" as const,
      inputParameter: 0,
    })),
  ],
]);

const UTILS_CODEX_TOKENS_PERSISTED_CODEC = {
  identity: { module: "codex-oauth.ts", exportName: "decodeCodexTokens" },
  inputParameter: 0,
  fixtureCatalog: {
    module: "codex-oauth.ts",
    exportName: "codexTokensCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const UTILS_CODEX_TOKENS_PERSISTED_CONSUMER = {
  identity: { module: "codex-oauth.ts", exportName: "readCodexTokensResult" },
  codecs: [UTILS_CODEX_TOKENS_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const ACP_RUN_RECORD_PERSISTED_CODEC = {
  identity: { module: "run-store.ts", exportName: "decodeRunRecord" },
  inputParameter: 0,
  fixtureCatalog: { module: "run-store.ts", exportName: "runRecordCodecCases" },
  provenance: ["current", "migrated"],
} as const satisfies PersistedCodecRegistration;

const ACP_RUN_CANCELLATION_PERSISTED_CODEC = {
  identity: { module: "run-store.ts", exportName: "decodeRunCancellation" },
  inputParameter: 0,
  fixtureCatalog: {
    module: "run-store.ts",
    exportName: "runCancellationCodecCases",
  },
  provenance: ["current", "migrated"],
} as const satisfies PersistedCodecRegistration;

const ACP_SESSION_INDEX_PERSISTED_CODEC = {
  identity: { module: "run-store.ts", exportName: "decodeSessionIndex" },
  inputParameter: 0,
  fixtureCatalog: {
    module: "run-store.ts",
    exportName: "sessionIndexCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const ACP_PERSISTED_CONSUMERS = [
  {
    identity: { module: "run-store.ts", exportName: "loadRunRecord" },
    codecs: [ACP_RUN_RECORD_PERSISTED_CODEC.identity],
  },
  {
    identity: { module: "run-store.ts", exportName: "loadRunCancellation" },
    codecs: [ACP_RUN_CANCELLATION_PERSISTED_CODEC.identity],
  },
  {
    identity: { module: "run-store.ts", exportName: "loadSessionIndex" },
    codecs: [ACP_SESSION_INDEX_PERSISTED_CODEC.identity],
  },
] as const satisfies readonly PersistedStoreConsumerRegistration[];

const TUI_BINDING_PREFERENCES_PERSISTED_CODEC = {
  identity: {
    module: "src/preferences.ts",
    exportName: "decodeBindingPreferences",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/preferences.ts",
    exportName: "bindingPreferencesCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const TUI_BINDING_PREFERENCES_PERSISTED_CONSUMER = {
  identity: {
    module: "src/preferences.ts",
    exportName: "loadBindingPreferences",
  },
  codecs: [TUI_BINDING_PREFERENCES_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const WAVE_3_OPERATIONAL_RESULT_APIS = new Map<string, readonly SymbolIdentity[]>([
  [
    "apps/acp-controller",
    [
      ["external-adapters.ts", "captureExternal"],
      ["session-index-lock.ts", "acquireSessionIndexLock"],
      ["session-index-lock.ts", "waitForLock"],
      ...[
        "decodeRunRecord",
        "decodeRunCancellation",
        "decodeSessionIndex",
        "saveRunRecord",
        "saveWorkerRunRecord",
        "commitRunCancellationRequest",
        "requestRunCancellation",
        "observeRunCancellation",
        "loadRunCancellation",
        "loadRunRecord",
        "loadSessionIndex",
        "upsertSessionIndexEntries",
        "setLocalSessionTitle",
      ].map((exportName) => ["run-store.ts", exportName]),
    ].map(([module, exportName]) => ({ module, exportName })),
  ],
  [
    "apps/mini-lilac",
    [
      ["build.ts", "captureBuildOperation"],
      ["build.ts", "decodeSourcePackage"],
      ["build.ts", "buildMiniLilac"],
      ["install-local.ts", "captureInstallOperation"],
      ["install-local.ts", "decodeNpmPackOutput"],
      ["install-local.ts", "installLocalPackage"],
      ["src/main.ts", "captureCommand"],
      ["src/main.ts", "runMiniLilac"],
    ].map(([module, exportName]) => ({ module, exportName })),
  ],
  [
    "apps/mini-lilac-server",
    [
      ...[
        "captureServerOperation",
        "captureServerCleanup",
        "acquireDatabaseLockResult",
        "shutdownMiniLilacServerResult",
        "shutdownMiniLilacServerAndReleaseLockResult",
        "runServeCommand",
        "decodeMiniLilacCliOptions",
        "captureNodeCliParsing",
        "parseCliArgsResult",
        "canonicalWorkspaceResult",
        "runHistoryRecoveryCommandResult",
        "initializeMiniLilacStateResult",
        "runAuthCommandResult",
        "mainResult",
      ].map((exportName) => ["src/main.ts", exportName]),
      ...[
        "decodeMiniLilacHttpRequest",
        "decodeMiniLilacUiMessages",
        "adaptMiniLilacPersistenceResult",
        "captureHttpOperation",
        "captureSessionCreation",
        "canonicalDirectory",
      ].map((exportName) => ["src/server.ts", exportName]),
    ].map(([module, exportName]) => ({ module, exportName })),
  ],
  [
    "apps/mini-lilac-tui",
    [
      ["src/cli.ts", "parseCliOptions"],
      ["src/clipboard.ts", "spawnClipboardCommand"],
      ["src/clipboard.ts", "openClipboardFile"],
      ["src/clipboard.ts", "statClipboardFile"],
      ["src/clipboard.ts", "readClipboardFile"],
      ["src/clipboard.ts", "closeClipboardFile"],
      ["src/clipboard.ts", "runAppleScript"],
      ["src/clipboard.ts", "removeClipboardFile"],
      ["src/clipboard.ts", "readClipboardImage"],
      ["src/preferences.ts", "decodeBindingPreferences"],
      ["src/preferences.ts", "bindingPreferencesFileExists"],
      ["src/preferences.ts", "readBindingPreferencesFile"],
      ["src/preferences.ts", "createBindingPreferencesDirectory"],
      ["src/preferences.ts", "writeBindingPreferencesFile"],
      ["src/preferences.ts", "renameBindingPreferencesFile"],
      ["src/preferences.ts", "removeTemporaryBindingPreferences"],
      ["src/preferences.ts", "loadBindingPreferences"],
      ["src/preferences.ts", "saveBindingPreferences"],
      ["src/startup.ts", "verifySessionCwd"],
      ["src/terminal-runtime-adapter.ts", "createTerminalRenderer"],
      ["src/terminal-runtime-adapter.ts", "readTerminalPalette"],
      ["src/terminal-runtime-adapter.ts", "setTerminalBackground"],
      ["src/terminal-runtime-adapter.ts", "renderTerminalApp"],
      ["src/terminal-runtime-adapter.ts", "destroyTerminalRenderer"],
      ["src/terminal-runtime-adapter.ts", "resolveTerminalShutdownOutcome"],
      ["src/terminal-runtime-adapter.ts", "runWithOwnedTerminalRenderer"],
      ["src/terminal-runtime-adapter.ts", "runTerminalEntrypoint"],
      ["src/terminal-stream-adapter.ts", "readTerminalStream"],
      ["src/terminal-stream-adapter.ts", "cancelTerminalStream"],
      ["src/terminal-stream-adapter.ts", "releaseTerminalStreamLock"],
    ].map(([module, exportName]) => ({ module, exportName })),
  ],
  [
    "apps/tool-bridge",
    [
      ...[
        "decodeListPayload",
        "decodeCallableIdListPayload",
        "decodeToolHelpPayload",
        "decodeToolCallPayload",
        "decodeBackendVersionPayload",
        "decodeOnboardingGpgGenerate",
        "decodeOnboardingGpgExport",
        "decodeJsonText",
        "decodeJsonObject",
      ].map((exportName) => ({ module: "client.ts", exportName })),
      ...["decodeInvocationRequest"].map((exportName) => ({
        module: "launcher.ts",
        exportName,
      })),
    ],
  ],
  [
    "packages/agent",
    [
      {
        module: "atomic-tool-execution.ts",
        exportName: "consumeAtomicToolResultStream",
      },
      {
        module: "atomic-tool-execution.ts",
        exportName: "cleanupFailedAtomicToolCall",
      },
      {
        module: "openai-server-compaction.ts",
        exportName: "compactWithOpenAIResponsesResult",
      },
    ],
  ],
]);

const TUI_UNKNOWN_FREE_MODULES = [
  { module: "src/render.ts" },
  { module: "src/transcript-buffer.ts" },
] as const satisfies readonly UnknownFreeModuleRegistration[];

const CORE_THREAD_PERSISTED_CODECS = [
  {
    identity: {
      module: "src/conversation/thread-summary-persistence-codec.ts",
      exportName: "decodeConversationThreadSummaryRow",
    },
    inputParameter: 0,
    fixtureCatalog: {
      module: "src/conversation/thread-summary-persistence-codec.ts",
      exportName: "conversationThreadSummaryRowCodecCases",
    },
    provenance: ["current", "migrated", "missing-defaulted"],
  },
] as const satisfies readonly PersistedCodecRegistration[];

const CORE_THREAD_PERSISTED_CONSUMERS = [
  "ConversationThreadStore.getSummary",
  "ConversationThreadStore.search",
  "ConversationThreadStore.searchSemantic",
].map(
  (exportName): PersistedStoreConsumerRegistration => ({
    identity: { module: "src/conversation/thread-store.ts", exportName },
    codecs: [CORE_THREAD_PERSISTED_CODECS[0].identity],
  }),
);

const CORE_TRANSCRIPT_PERSISTED_CODECS = [
  ["decodeTranscriptCompactionContext", "transcriptCompactionContextCodecCases"],
  ["decodeTranscriptProviderState", "transcriptProviderStateCodecCases"],
  ["decodeTranscriptRow", "transcriptRowCodecCases"],
  ["decodeCoreSurfaceProjectionRow", "coreSurfaceProjectionRowCodecCases"],
  ["decodeCoreLineageManifestRow", "coreLineageManifestRowCodecCases"],
  ["decodeRecentAgentWriteRow", "recentAgentWriteRowCodecCases"],
  ["decodeDiscoveryRecordRow", "discoveryRecordRowCodecCases"],
  ["decodeSurfaceMessageLinkRow", "surfaceMessageLinkRowCodecCases"],
].map(
  ([exportName, fixtureExportName]): PersistedCodecRegistration => ({
    identity: {
      module: "src/transcript/transcript-persistence-codec.ts",
      exportName,
    },
    inputParameter: 0,
    fixtureCatalog: {
      module: "src/transcript/transcript-persistence-codec.ts",
      exportName: fixtureExportName,
    },
    provenance:
      exportName === "decodeRecentAgentWriteRow" ||
      exportName === "decodeDiscoveryRecordRow" ||
      exportName === "decodeSurfaceMessageLinkRow"
        ? ["current", "migrated"]
        : ["current", "migrated", "missing-defaulted"],
  }),
);

const CORE_RESOURCE_PERSISTED_CODEC = {
  identity: {
    module: "src/transcript/transcript-persistence-codec.ts",
    exportName: "decodeResourceRecordRow",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/transcript/transcript-persistence-codec.ts",
    exportName: "resourceRecordRowCodecCases",
  },
  provenance: ["current"],
  legacyOutcome: "rejected",
} as const satisfies PersistedCodecRegistration;

const CORE_RESOURCE_PERSISTED_CONSUMER = {
  identity: {
    module: "src/transcript/transcript-store.ts",
    exportName: "decodeResourceRecordRow",
  },
  codecs: [CORE_RESOURCE_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const CORE_TRANSCRIPT_PERSISTED_CONSUMERS = [
  ["decodeTranscriptCompactionContext", [0]],
  ["decodeTranscriptRow", [2]],
  ["decodeCoreSurfaceProjectionRow", [3]],
  ["decodeCoreLineageManifestRow", [4]],
  ["decodeRecentAgentWriteRow", [5]],
  ["decodeDiscoveryRecordRow", [6]],
  ["decodeSurfaceMessageLinkRow", [7]],
].map(
  ([exportName, codecIndexes]): PersistedStoreConsumerRegistration => ({
    identity: {
      module: "src/transcript/transcript-store.ts",
      exportName: String(exportName),
    },
    codecs: (codecIndexes as number[]).map(
      (index) => CORE_TRANSCRIPT_PERSISTED_CODECS[index]!.identity,
    ),
  }),
);

const CORE_CLAUDE_ATTEMPT_PERSISTED_CONSUMER = {
  identity: {
    module: "src/transcript/claude-attempt-lifecycle.ts",
    exportName: "CoreClaudeAttemptLifecycle.reserve",
  },
  codecs: [
    {
      module: "src/transcript/transcript-persistence-codec.ts",
      exportName: "decodeTranscriptRow",
    },
  ],
} as const satisfies PersistedStoreConsumerRegistration;

const CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC = {
  identity: {
    module: "src/workflow/workflow-artifact-persistence-codec.ts",
    exportName: "decodeWorkflowValueArtifact",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/workflow/workflow-artifact-persistence-codec.ts",
    exportName: "workflowValueArtifactCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const CORE_LEGACY_WORKFLOW_BLOB_MIGRATION_PERSISTED_CONSUMER = {
  identity: {
    module: "scripts/legacy-workflow-blob-migration.ts",
    exportName: "inspectLegacyWorkflowBlobMigration",
  },
  codecs: [CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const CORE_ANTHROPIC_FALLBACK_CACHE_PERSISTED_CODEC = {
  identity: {
    module: "src/surface/bridge/bus-agent-runner/anthropic-fallback-cache-codec.ts",
    exportName: "decodeAnthropicFallbackCacheRecord",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/surface/bridge/bus-agent-runner/anthropic-fallback-cache-codec.ts",
    exportName: "anthropicFallbackCacheCodecCases",
  },
  provenance: ["current"],
  legacyOutcome: "rejected",
} as const satisfies PersistedCodecRegistration;

const CORE_ANTHROPIC_FALLBACK_CACHE_PERSISTED_CONSUMER = {
  identity: {
    module: "src/surface/bridge/bus-agent-runner/anthropic-fallback-media.ts",
    exportName: "readAnthropicFallbackCacheIndex",
  },
  codecs: [CORE_ANTHROPIC_FALLBACK_CACHE_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const CORE_WORKFLOW_ROW_PERSISTED_CODEC = {
  identity: {
    module: "src/workflow/workflow-persistence-codec.ts",
    exportName: "decodeWorkflowPersistenceRow",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/workflow/workflow-persistence-codec.ts",
    exportName: "workflowPersistenceRowCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
  missingOutcomes: {
    revision: "missing-rejected",
    run: "missing-rejected",
    operation: "missing-rejected",
    wait: "missing-rejected",
    trigger: "missing-rejected",
    binding: "missing-rejected",
    action: "missing-defaulted",
    dispatch: "missing-rejected",
    receipt: "missing-rejected",
    outbox: "missing-rejected",
    "legacy-audit": "missing-rejected",
    artifact: "missing-rejected",
  },
} as const satisfies PersistedCodecRegistration;

const CORE_WORKFLOW_ROW_PERSISTED_CONSUMERS = [
  "decodeWorkflowRevisionRow",
  "decodeWorkflowRunRow",
  "decodeWorkflowOperationRow",
  "decodeWorkflowWaitRow",
  "decodeWorkflowTriggerRow",
  "decodeWorkflowSurfaceBindingRow",
  "decodeWorkflowSurfaceActionRow",
  "decodeWorkflowRequestDispatchRow",
  "decodeWorkflowRequestTerminalReceiptRow",
  "decodeWorkflowActionOutboxRow",
  "decodeWorkflowArtifactRow",
].map(
  (exportName): PersistedStoreConsumerRegistration => ({
    identity: { module: "src/workflow/durable-workflow-store.ts", exportName },
    codecs: [CORE_WORKFLOW_ROW_PERSISTED_CODEC.identity],
  }),
);

const CORE_WORKFLOW_STORE_READ_RESULT_APIS = [
  "captureWorkflowRead",
  "DurableWorkflowStore.getRevision",
  "DurableWorkflowStore.findRevisionByIdentity",
  "DurableWorkflowStore.listRevisions",
  "DurableWorkflowStore.getRun",
  "DurableWorkflowStore.listRuns",
  "DurableWorkflowStore.listActiveRuns",
  "DurableWorkflowStore.listRunsNeedingProjectionReconciliation",
  "DurableWorkflowStore.listActiveLiveParentRuns",
  "DurableWorkflowStore.listPendingLiveParentCompletions",
  "DurableWorkflowStore.getOperation",
  "DurableWorkflowStore.getOperationByRequestId",
  "DurableWorkflowStore.getWorkflowRequestTerminalReceipt",
  "DurableWorkflowStore.getWorkflowRequestDispatchPolicy",
  "DurableWorkflowStore.listOperations",
  "DurableWorkflowStore.listRecentMeaningfulOperations",
  "DurableWorkflowStore.getWait",
  "DurableWorkflowStore.listWaits",
  "DurableWorkflowStore.listActiveWaitsByMatchKey",
  "DurableWorkflowStore.listDueWaits",
  "DurableWorkflowStore.getTrigger",
  "DurableWorkflowStore.getTriggerByLastRunId",
  "DurableWorkflowStore.listTriggers",
  "DurableWorkflowStore.getSurfaceBinding",
  "DurableWorkflowStore.listSurfaceBindings",
  "DurableWorkflowStore.getSurfaceAction",
  "DurableWorkflowStore.getSurfaceActionByTokenSha256",
  "DurableWorkflowStore.listSurfaceActions",
  "DurableWorkflowStore.listPendingActionOutboxEvents",
  "DurableWorkflowStore.listPendingActionOutboxProjections",
].map((exportName) => ({
  module: "src/workflow/durable-workflow-store.ts",
  exportName,
}));

const CORE_WORKFLOW_ARTIFACT_PERSISTED_CONSUMER = {
  identity: {
    module: "src/workflow/workflow-artifact-store.ts",
    exportName: "readWorkflowValueArtifact",
  },
  codecs: [CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const TOOL_RESULT_ARTIFACT_METADATA_CODEC = {
  identity: {
    module: "src/tool-result-artifact-metadata-codec.ts",
    exportName: "decodeToolResultArtifactMetadata",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/tool-result-artifact-metadata-codec.ts",
    exportName: "toolResultArtifactMetadataCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const TOOL_RESULT_ARTIFACT_METADATA_CONSUMER = {
  identity: {
    module: "src/tool-result-artifact-store.ts",
    exportName: "createToolResultArtifactStore.readMetadata",
  },
  codecs: [TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const BLOB_TOOL_RESULT_ARTIFACT_METADATA_CODEC = {
  identity: {
    module: "src/blob-tool-result-artifact-metadata-codec.ts",
    exportName: "decodeBlobToolResultArtifactMetadata",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/blob-tool-result-artifact-metadata-codec.ts",
    exportName: "blobToolResultArtifactMetadataCodecCases",
  },
  provenance: ["current"],
  legacyOutcome: "rejected",
} as const satisfies PersistedCodecRegistration;

const BLOB_TOOL_RESULT_ARTIFACT_METADATA_CONSUMER = {
  identity: {
    module: "src/blob-tool-result-artifact-store.ts",
    exportName: "createBlobBackedToolResultArtifactStore.readMetadata",
  },
  codecs: [BLOB_TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const CORE_AGENT_RUN_OPENED_PERSISTED_CODEC = {
  identity: {
    module: "src/surface/bridge/agent-run-journal/index.ts",
    exportName: "decodeAgentRunOpenedPayload",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/surface/bridge/agent-run-journal/index.ts",
    exportName: "agentRunOpenedPayloadCodecCases",
  },
  provenance: ["current"],
  legacyOutcome: "rejected",
} as const satisfies PersistedCodecRegistration;

const CORE_AGENT_RUN_CHECKPOINT_PERSISTED_CODEC = {
  identity: {
    module: "src/surface/bridge/agent-run-journal/index.ts",
    exportName: "decodeAgentRunCheckpointPayload",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/surface/bridge/agent-run-journal/index.ts",
    exportName: "agentRunCheckpointPayloadCodecCases",
  },
  provenance: ["current"],
  legacyOutcome: "rejected",
} as const satisfies PersistedCodecRegistration;

const CORE_AGENT_RUN_TERMINAL_PERSISTED_CODEC = {
  identity: {
    module: "src/surface/bridge/agent-run-journal/index.ts",
    exportName: "decodeAgentRunTerminalPayload",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/surface/bridge/agent-run-journal/index.ts",
    exportName: "agentRunTerminalPayloadCodecCases",
  },
  provenance: ["current"],
  legacyOutcome: "rejected",
} as const satisfies PersistedCodecRegistration;

const CORE_AGENT_RUN_JOURNAL_PERSISTED_CONSUMER = {
  identity: {
    module: "src/surface/bridge/agent-run-journal/index.ts",
    exportName: "SqliteAgentRunJournal.#decodeHead",
  },
  codecs: [
    CORE_AGENT_RUN_CHECKPOINT_PERSISTED_CODEC.identity,
    CORE_AGENT_RUN_TERMINAL_PERSISTED_CODEC.identity,
  ],
} as const satisfies PersistedStoreConsumerRegistration;

const CORE_AGENT_RUN_OPENED_EVENT_PERSISTED_CONSUMER = {
  identity: {
    module: "src/surface/bridge/agent-run-journal/index.ts",
    exportName: "SqliteAgentRunJournal.#validateHeadEvents",
  },
  codecs: [CORE_AGENT_RUN_OPENED_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const CORE_AGENT_RUN_PREVIOUS_CHECKPOINT_PERSISTED_CONSUMER = {
  identity: {
    module: "src/surface/bridge/agent-run-journal/index.ts",
    exportName: "SqliteAgentRunJournal.#decodePreviousCheckpoint",
  },
  codecs: [CORE_AGENT_RUN_CHECKPOINT_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const CORE_AGENT_RUN_JOURNAL_ENCODER_CONSUMERS = [
  {
    identity: {
      module: "src/surface/bridge/agent-run-journal/index.ts",
      exportName: "validatedOpenedPayload",
    },
    codecs: [CORE_AGENT_RUN_OPENED_PERSISTED_CODEC.identity],
  },
  {
    identity: {
      module: "src/surface/bridge/agent-run-journal/index.ts",
      exportName: "validatedCheckpointPayload",
    },
    codecs: [CORE_AGENT_RUN_CHECKPOINT_PERSISTED_CODEC.identity],
  },
  {
    identity: {
      module: "src/surface/bridge/agent-run-journal/index.ts",
      exportName: "validatedTerminalPayload",
    },
    codecs: [CORE_AGENT_RUN_TERMINAL_PERSISTED_CODEC.identity],
  },
] as const satisfies readonly PersistedStoreConsumerRegistration[];

const CORE_GRACEFUL_RESTART_PERSISTED_CODEC = {
  identity: {
    module: "src/migration/frozen-graceful-restart-store.ts",
    exportName: "decodeGracefulRestartSnapshot",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/migration/frozen-graceful-restart-store.ts",
    exportName: "gracefulRestartSnapshotCodecCases",
  },
  provenance: ["current", "missing-defaulted"],
  legacyOutcome: "rejected",
} as const satisfies PersistedCodecRegistration;

const CORE_LEGACY_GRACEFUL_RESTART_PERSISTED_CONSUMER = {
  identity: {
    module: "scripts/legacy-graceful-restart-blob-migration.ts",
    exportName: "classifyPersistedSnapshot",
  },
  codecs: [CORE_GRACEFUL_RESTART_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_WORKSPACE_HISTORY_PERSISTED_CODECS = (
  [
    [
      "decodeWorkspaceHistoryOwnership",
      "workspaceHistoryOwnershipCodecCases",
      ["current", "migrated"],
    ],
    [
      "decodeWorkspaceHistorySnapshotManifest",
      "workspaceHistorySnapshotManifestCodecCases",
      ["current", "migrated"],
    ],
    [
      "decodeWorkspaceHistoryCaptureCache",
      "workspaceHistoryCaptureCacheCodecCases",
      ["current", "migrated", "missing-defaulted"],
    ],
    [
      "decodeWorkspaceHistoryRestorePlan",
      "workspaceHistoryRestorePlanCodecCases",
      ["current", "migrated", "missing-defaulted"],
    ],
    [
      "decodeWorkspaceHistorySnapshotRefCreated",
      "workspaceHistorySnapshotRefCreatedCodecCases",
      ["current", "migrated", "missing-defaulted"],
    ],
    [
      "decodeWorkspaceHistoryRestoreOwnership",
      "workspaceHistoryRestoreOwnershipCodecCases",
      ["current", "migrated", "missing-defaulted"],
    ],
  ] as const
).map(
  ([exportName, fixtureExportName, provenance]): PersistedCodecRegistration => ({
    identity: {
      module: "src/workspace-history-persistence-codec.ts",
      exportName,
    },
    inputParameter: 0,
    fixtureCatalog: {
      module: "src/workspace-history-persistence-codec.ts",
      exportName: fixtureExportName,
    },
    provenance,
  }),
);

const MINI_WORKSPACE_HISTORY_PERSISTED_CONSUMERS = (
  [
    ["WorkspaceHistoryStore.decodeOwnership", 0],
    ["WorkspaceHistoryStore.decodeSnapshotManifest", 1],
    ["WorkspaceHistoryStore.readCaptureCache", 2],
    ["WorkspaceHistoryStore.decodeRestorePlan", 3],
    ["WorkspaceHistoryStore.decodeSnapshotRefCreationMetadata", 4],
    ["WorkspaceHistoryStore.decodeRestoreOwnership", 5],
  ] as const
).map(
  ([exportName, codecIndex]): PersistedStoreConsumerRegistration => ({
    identity: { module: "src/workspace-history-store.ts", exportName },
    codecs: [MINI_WORKSPACE_HISTORY_PERSISTED_CODECS[codecIndex]!.identity],
  }),
);

const MINI_SQLITE_TRANSCRIPT_PERSISTED_CODECS = [
  ["decodeMiniLilacModelTranscript", "miniLilacModelTranscriptCodecCases"],
  ["decodeMiniLilacUiTranscript", "miniLilacUiTranscriptCodecCases"],
  ["decodeMiniLilacCommandRequest", "miniLilacCommandRequestCodecCases"],
].map(
  ([exportName, fixtureExportName]): PersistedCodecRegistration => ({
    identity: { module: "src/sqlite-persistence-codec.ts", exportName },
    inputParameter: 0,
    fixtureCatalog: {
      module: "src/sqlite-persistence-codec.ts",
      exportName: fixtureExportName,
    },
    provenance: ["current", "migrated", "missing-defaulted"],
  }),
);

const MINI_SQLITE_TODO_PERSISTED_CODEC = {
  identity: {
    module: "src/sqlite-todo-persistence-codec.ts",
    exportName: "decodeMiniLilacTodos",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/sqlite-todo-persistence-codec.ts",
    exportName: "miniLilacTodosCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const MINI_SQLITE_TODO_PERSISTED_CONSUMER = {
  identity: {
    module: "src/sqlite-todo-persistence-codec.ts",
    exportName: "readMiniLilacTodos",
  },
  codecs: [MINI_SQLITE_TODO_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_SQLITE_TODO_STORE_PERSISTED_CONSUMER = {
  identity: {
    module: "src/sqlite-store.ts",
    exportName: "decodeMiniLilacTodos",
  },
  codecs: [MINI_SQLITE_TODO_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC = {
  identity: {
    module: "src/sqlite-history-persistence-codec.ts",
    exportName: "decodeMiniLilacStructuralHistoryRow",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/sqlite-history-persistence-codec.ts",
    exportName: "miniLilacStructuralHistoryRowCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const MINI_SQLITE_MIGRATION_RUN_RESULT_DECODER = {
  identity: {
    module: "src/sqlite-history-persistence-codec.ts",
    exportName: "decodeMiniLilacMigrationRunRow",
  },
  category: "persistence",
  inputParameter: 0,
} as const satisfies ResultDecoderRegistration;

const MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CONSUMER = {
  identity: {
    module: "src/sqlite-store.ts",
    exportName: "MiniLilacSqliteStore.decodeStructuralHistoryRow",
  },
  codecs: [MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_SQLITE_STRUCTURAL_HISTORY_ROWS_PERSISTED_CONSUMERS = [
  {
    identity: {
      module: "src/sqlite-history-persistence-codec.ts",
      exportName: "decodeMiniLilacStructuralHistoryRows",
    },
    codecs: [MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC.identity],
  },
] as const satisfies readonly PersistedStoreConsumerRegistration[];

const MINI_SQLITE_HISTORY_RECOVERY_PERSISTED_CONSUMER = {
  identity: {
    module: "src/sqlite-store.ts",
    exportName: "readMiniLilacHistoryRecoveryStatusResult",
  },
  codecs: [MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_SQLITE_TRANSCRIPT_PERSISTED_CONSUMERS = (
  [
    ["decodeMiniLilacModelTranscript", [0]],
    ["decodeMiniLilacUiTranscript", [1]],
  ] as const
).map(
  ([exportName, codecIndexes]): PersistedStoreConsumerRegistration => ({
    identity: { module: "src/sqlite-store.ts", exportName },
    codecs: codecIndexes.map((index) => MINI_SQLITE_TRANSCRIPT_PERSISTED_CODECS[index]!.identity),
  }),
);

const MINI_SQLITE_BOUNDARY_DECODER_IDENTITIES = [
  ...[
    "decodePlainJson",
    "decodeSuperJson",
    "decodeTranscript",
    "decodeMiniLilacDatabaseVersion",
    "migrateMiniLilacUiMessageValue",
    "decodeMiniLilacTranscriptChain",
    "decodeMiniLilacMigrationTranscriptRows",
    "decodeMiniLilacMigrationUiTranscript",
    "decodeMiniLilacMigrationUserUiMessage",
    "decodeMiniLilacMigrationModelPrefix",
    "decodeMiniLilacMigrationUiPrefix",
    "decodeMiniLilacModelTranscript",
    "decodeMiniLilacUiTranscript",
    "decodeMiniLilacHistoryUserMessage",
    "decodeMiniLilacCommandRequest",
    "decodeMiniLilacSteeringCommandRequest",
    "decodeMiniLilacSuperJsonPayload",
    "decodeMiniMainClaudeBindingPromotion",
    "decodeMiniNamedClaudeBindingPromotion",
  ].map((exportName) => ({
    module: "src/sqlite-persistence-codec.ts",
    exportName,
  })),
  {
    module: "src/sqlite-transcript-projection.ts",
    exportName: "validateMiniLilacPersistedSuperJsonValue",
  },
  {
    module: "src/sqlite-history-persistence-codec.ts",
    exportName: "decodeMiniLilacStructuralHistoryRow",
  },
  {
    module: "src/sqlite-history-persistence-codec.ts",
    exportName: "decodeMiniLilacStructuralHistoryRows",
  },
  MINI_SQLITE_MIGRATION_RUN_RESULT_DECODER.identity,
];

const MINI_SQLITE_STORE_RESULT_APIS = [
  "MiniLilacSqliteStore.decodeStructuralHistoryRow",
  "MiniLilacSqliteStore.decodeStructuralHistoryRows",
  "MiniLilacSqliteStore.getTodosResult",
  "MiniLilacSqliteStore.getModelMessagesResult",
  "MiniLilacSqliteStore.getModelTranscriptResult",
  "MiniLilacSqliteStore.getUiMessagesResult",
  "MiniLilacSqliteStore.getUiTranscriptResult",
  "MiniLilacSqliteStore.getHistoryStoreMetadataResult",
  "MiniLilacSqliteStore.getWorkspaceForSessionResult",
  "MiniLilacSqliteStore.listWorkspacesResult",
  "MiniLilacSqliteStore.listWorkspaceSnapshotsResult",
  "MiniLilacSqliteStore.listWorkspaceSnapshotGroupsResult",
  "MiniLilacSqliteStore.getWorkspaceSnapshotResult",
  "MiniLilacSqliteStore.getHistoryStateResult",
  "MiniLilacSqliteStore.getHistoryStateModelMessagesResult",
  "MiniLilacSqliteStore.getHistoryStateUiMessagesResult",
  "MiniLilacSqliteStore.getCurrentHistoryStateResult",
  "MiniLilacSqliteStore.getSessionHistoryResult",
  "MiniLilacSqliteStore.getHistoryNavigationResult",
  "MiniLilacSqliteStore.findLatestUndoableUserTransitionResult",
  "MiniLilacSqliteStore.peekHistoryRedoResult",
  "MiniLilacSqliteStore.listHistoryTopologyResult",
  "MiniLilacSqliteStore.getHistoryAccountingResult",
  "MiniLilacSqliteStore.getHistoryOperationResult",
  "MiniLilacSqliteStore.listHistoryOperationsResult",
  "MiniLilacSqliteStore.getPendingRunFinalizationResult",
  "MiniLilacSqliteStore.listPendingRunFinalizationsResult",
  "MiniLilacSqliteStore.listRecoverableOpenRootRunsResult",
  "MiniLilacSqliteStore.getHistoryTransitionResult",
  "readMiniLilacHistoryRecoveryStatusResult",
].map((exportName) => ({ module: "src/sqlite-store.ts", exportName }));

const MINI_SESSION_SERVICE_RESULT_APIS = [
  "SessionService.capturePersistenceResult",
  "SessionService.capturePersistencePromise",
  "SessionService.createSessionResult",
  "SessionService.getSnapshotResult",
  "SessionService.listSessionsResult",
  "SessionService.getMessagesResult",
  "SessionService.getSessionResumeResult",
  "SessionService.getTodosResult",
  "SessionService.getRunResult",
  "SessionService.startPromptResult",
  "SessionService.replayRunResult",
  "SessionService.steerResult",
  "SessionService.interruptQueuedSteeringResult",
  "SessionService.cancelResult",
  "SessionService.undoResult",
  "SessionService.redoResult",
  "SessionService.compactResult",
  "SessionService.cancelCompactionResult",
  "SessionService.updateSessionBindingsResult",
].map((exportName) => ({ module: "src/session-service.ts", exportName }));

const MINI_RUNTIME_OPERATIONAL_RESULT_APIS = [
  ...["decodeRuntimeConfig", "decodeRuntimeConfigYaml", "loadRuntimeConfigResult"].map(
    (exportName) => ({ module: "src/config.ts", exportName }),
  ),
  ...[
    "decodeProviderConfig",
    "decodeProviderAuth",
    "decodeProviderConfigYaml",
    "loadProviderConfigResult",
    "loadProviderAuthResult",
    "writeProviderAuthResult",
    "createAiProviderRegistryResult",
    "loadProviderRegistryResult",
  ].map((exportName) => ({ module: "src/providers.ts", exportName })),
  ...[
    "parseModelRefResult",
    "resolveLanguageModelResult",
    "ModelCatalog.getResult",
    "createModelCatalogResult",
  ].map((exportName) => ({ module: "src/model-catalog.ts", exportName })),
  ...["MiniLilacSkillCatalogSnapshot.loadResult", "MiniLilacSkillCatalog.discoverResult"].map(
    (exportName) => ({ module: "src/skills.ts", exportName }),
  ),
  ...["decodeWebfetchInput", "executeWebfetchResult"].map((exportName) => ({
    module: "src/webfetch.ts",
    exportName,
  })),
  {
    module: "src/workspace-history-store.ts",
    exportName: "createWorkspaceHistoryStore",
  },
  ...[
    "WorkspaceHistoryStore.capabilityResult",
    "WorkspaceHistoryStore.withWorkspaceLockResult",
    "WorkspaceHistoryStore.withWorkspaceLockOutcome.withStoreLock.<callback@2>.captureResult",
    "WorkspaceHistoryStore.withWorkspaceLockOutcome.withStoreLock.<callback@2>.lockedStore.invalidateCaptureCacheResult",
    "WorkspaceHistoryStore.captureResult",
    "WorkspaceHistoryStore.restoreResult",
    "WorkspaceHistoryStore.resumeRestoreResult",
    "WorkspaceHistoryStore.deleteRestorePlanResult",
    "WorkspaceHistoryStore.cleanupRestorePlansResult",
    "WorkspaceHistoryStore.verifySnapshotResult",
    "WorkspaceHistoryStore.objectExistsResult",
    "WorkspaceHistoryStore.reconcileSnapshotRefResult",
    "WorkspaceHistoryStore.reconcileExpectedSnapshotRefsResult",
    "WorkspaceHistoryStore.cleanupOrphanSnapshotRefsResult",
    "WorkspaceHistoryStore.getObjectAccountingResult",
    "WorkspaceHistoryStore.runMaintenanceResult",
    "WorkspaceHistoryStore.cleanupStaleRestoreArtifactsResult",
  ].map((exportName) => ({
    module: "src/workspace-history-store.ts",
    exportName,
  })),
] as const satisfies readonly SymbolIdentity[];

const UTILS_SQLITE_TRANSACTION_ADAPTER_IDENTITY = {
  package: "@stanley2058/lilac-utils",
  module: "persistence.ts",
  exportName: "runBunSqliteTransaction",
} as const satisfies PackageSymbolIdentity;

const CORE_SQLITE_TRANSACTION_CONSUMERS = [
  {
    module: "src/conversation/thread-store.ts",
    exportName: "ConversationThreadStore.upsertSummary",
  },
  {
    module: "src/surface/bridge/request-delivery/sqlite-store.ts",
    exportName: "transaction",
  },
  {
    module: "src/surface/bridge/agent-run-journal/index.ts",
    exportName: "transaction",
  },
  {
    module: "src/transcript/transcript-store.ts",
    exportName: "SqliteTranscriptStore.saveRequestTranscript",
  },
  ...[
    "SqliteTranscriptStore.admitCoreSurfaceProjection",
    "SqliteTranscriptStore.saveCorePrimaryLineageManifest",
    "SqliteTranscriptStore.unlinkSurfaceMessage",
    "SqliteTranscriptStore.deleteUnlinkedCheckpointCandidate",
    "SqliteTranscriptStore.reserveCoreNamedClaudeSessionAttempt",
    "SqliteTranscriptStore.recordCoreNamedClaudeSessionAttemptOutcome",
    "SqliteTranscriptStore.publishCoreNamedClaudeSuccess",
    "SqliteTranscriptStore.promoteCoreNamedClaudeSessionBinding",
    "SqliteTranscriptStore.reserveCorePrimaryClaudeSessionAttempt",
    "SqliteTranscriptStore.recordCorePrimaryClaudeSessionAttemptOutcome",
    "SqliteTranscriptStore.publishCorePrimaryClaudeSuccess",
    "SqliteTranscriptStore.promoteCorePrimaryClaudeSessionBinding",
    "SqliteTranscriptStore.registerOrGet",
    "SqliteTranscriptStore.compareAndSwapCache",
    "SqliteTranscriptStore.finalizeUnretained",
    "SqliteTranscriptStore.retainAgentRunCheckpointBlobs",
    "SqliteTranscriptStore.replaceAgentRunCheckpointBlobs",
    "SqliteTranscriptStore.reconcileAgentRunCheckpointBlobs",
  ].map((exportName) => ({
    module: "src/transcript/transcript-store.ts",
    exportName,
  })),
  {
    module: "src/workflow/durable-workflow-store.ts",
    exportName: "DurableWorkflowStore.createInvocation",
  },
  {
    module: "src/workflow/durable-workflow-store.ts",
    exportName: "DurableWorkflowStore.applySurfaceAction",
  },
  {
    module: "src/workflow/durable-workflow-store.ts",
    exportName: "runWorkflowTransaction",
  },
  {
    module: "src/workflow/workflow-migrations.ts",
    exportName: "applyWorkflowSchemaMigrations",
  },
  {
    module: "src/workflow/workflow-migrations.ts",
    exportName: "applyWorkflowBlobStorageSchema26Migration",
  },
  ...[
    "SqliteQuestionStore.create",
    "SqliteQuestionStore.replaceTokens",
    "SqliteQuestionStore.applyAnswer",
    "SqliteQuestionStore.interruptPending",
  ].map((exportName) => ({
    module: "src/question/question-store.ts",
    exportName,
  })),
  {
    module: "scripts/legacy-graceful-restart-blob-migration.ts",
    exportName: "commitLegacyGracefulRestartMigration",
  },
].map(
  (identity): SqliteTransactionConsumerRegistration => ({
    identity,
    adapter: UTILS_SQLITE_TRANSACTION_ADAPTER_IDENTITY,
  }),
);

const MINI_SQLITE_TRANSACTION_CONSUMERS = [
  {
    identity: {
      module: "src/sqlite-store.ts",
      exportName: "MiniLilacSqliteStore.initializeSchemaResult",
    },
    adapter: UTILS_SQLITE_TRANSACTION_ADAPTER_IDENTITY,
  },
  {
    identity: {
      module: "src/sqlite-store.ts",
      exportName: "MiniLilacSqliteStore.runStoreTransactionResult",
    },
    adapter: UTILS_SQLITE_TRANSACTION_ADAPTER_IDENTITY,
  },
] as const satisfies readonly SqliteTransactionConsumerRegistration[];

const CORE_EVENT_DELIVERY_CONSUMERS = [
  {
    identity: {
      module: "src/surface/bridge/request-delivery/durable-request-bus.ts",
      exportName: "createDurableCoreRequestBus",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic", "fetchTopic"],
  },
  {
    identity: {
      module: "src/heartbeat/heartbeat-service.ts",
      exportName: "startHeartbeatServiceResult.startHeartbeatLifecycleResult",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/surface/bridge/bus-agent-runner.ts",
      exportName: "startBusAgentRunner",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/surface/discord/discord-request-router.ts",
      exportName: "startDiscordRequestRouter",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/surface/bridge/subscribe-from-bus.ts",
      exportName: "bridgeBusToAdapter",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-action-resolver.ts",
      exportName: "startWorkflowActionResolver.startWorkflowActionSubscriptionResult",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-engine.ts",
      exportName: "WorkflowEngine.startWakeSubscription",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-engine.ts",
      exportName: "WorkflowEngine.waitForAgentRequest",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic", "fetchTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-live-parent-bridge.ts",
      exportName: "WorkflowLiveParentBridge.start",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-live-parent-bridge.ts",
      exportName: "WorkflowLiveParentBridge.ensureChildOutputSubscription",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-live-parent-bridge.ts",
      exportName: "WorkflowLiveParentBridge.reconcileTerminalChildActivity",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["fetchTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-progress-projector.ts",
      exportName: "WorkflowProgressProjector.startWorkflowProgressSubscriptionResult",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-wait-resolver.ts",
      exportName: "WorkflowWaitResolver.startWorkflowWaitSubscriptionResult",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
] as const satisfies readonly EventDeliveryConsumerRegistration[];

const ARCHITECTURE_WORKSPACES = ACTIVE_WORKSPACES.map(([root, packageName]) => {
  const ruleZones: WorkspaceArchitecture["ruleZones"] = {
    ...EMPTY_POLICY.ruleZones,
    "architecture/open-protocol-normalization": OPEN_PROTOCOL_RULE_ZONES.get(root) ?? [],
    "architecture/complete-event-codec-registry":
      root === "packages/event-bus" ? [{ include: "lilac-codecs.ts" }] : [],
    "architecture/complete-tool-codec-registry":
      root === "apps/mini-lilac-tui" ? [{ include: "src/tool-observation-projection.ts" }] : [],
    "architecture/result-decoder-contract":
      root === "apps/mini-lilac-tui"
        ? [{ include: "src/tool-observation-projection.ts" }]
        : root === "packages/mini-lilac-runtime"
          ? [
              {
                include: MINI_SQLITE_MIGRATION_RUN_RESULT_DECODER.identity.module,
              },
            ]
          : [
              ...new Set(
                (WAVE_2_RESULT_DECODERS.get(root) ?? []).map(({ identity }) => identity.module),
              ),
            ].map((include) => ({ include })),
    "architecture/unknown-free-module":
      root === "apps/mini-lilac-tui"
        ? TUI_UNKNOWN_FREE_MODULES.map(({ module }) => ({ include: module }))
        : [],
    "architecture/persisted-codec-contract":
      root === "apps/acp-controller"
        ? [{ include: "run-store.ts" }]
        : root === "apps/mini-lilac-tui"
          ? [{ include: "src/preferences.ts" }]
          : root === "packages/tool-results"
            ? [
                {
                  include: TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity.module,
                },
                {
                  include: TOOL_RESULT_ARTIFACT_METADATA_CONSUMER.identity.module,
                },
                {
                  include: BLOB_TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity.module,
                },
                {
                  include: BLOB_TOOL_RESULT_ARTIFACT_METADATA_CONSUMER.identity.module,
                },
              ]
            : root === "apps/core"
              ? [
                  {
                    include: "src/conversation/thread-summary-persistence-codec.ts",
                  },
                  { include: "src/conversation/thread-store.ts" },
                  { include: "src/transcript/transcript-persistence-codec.ts" },
                  { include: "src/transcript/transcript-store.ts" },
                  { include: CORE_CLAUDE_ATTEMPT_PERSISTED_CONSUMER.identity.module },
                  { include: "src/surface/bridge/agent-run-journal/index.ts" },
                  { include: "src/migration/frozen-graceful-restart-store.ts" },
                  {
                    include: "src/workflow/workflow-artifact-persistence-codec.ts",
                  },
                  { include: "src/workflow/workflow-persistence-codec.ts" },
                  { include: "src/workflow/workflow-artifact-store.ts" },
                  { include: "src/workflow/durable-workflow-store.ts" },
                  {
                    include: "scripts/legacy-graceful-restart-blob-migration.ts",
                  },
                  { include: "scripts/legacy-workflow-blob-migration.ts" },
                  {
                    include: CORE_ANTHROPIC_FALLBACK_CACHE_PERSISTED_CODEC.identity.module,
                  },
                  {
                    include: CORE_ANTHROPIC_FALLBACK_CACHE_PERSISTED_CONSUMER.identity.module,
                  },
                ]
              : root === "packages/mini-lilac-runtime"
                ? [
                    { include: "src/workspace-history-persistence-codec.ts" },
                    { include: "src/workspace-history-store.ts" },
                    { include: "src/sqlite-persistence-codec.ts" },
                    { include: "src/sqlite-history-persistence-codec.ts" },
                    { include: "src/sqlite-store.ts" },
                    { include: "src/sqlite-todo-persistence-codec.ts" },
                  ]
                : root === "packages/utils"
                  ? [
                      {
                        include: UTILS_CODEX_TOKENS_PERSISTED_CODEC.identity.module,
                      },
                      {
                        include: UTILS_CODEX_TOKENS_PERSISTED_CONSUMER.identity.module,
                      },
                    ]
                  : [],
    "architecture/persisted-codec-fixture-catalog":
      root === "apps/acp-controller"
        ? [{ include: "run-store.ts" }]
        : root === "apps/mini-lilac-tui"
          ? [{ include: "src/preferences.ts" }]
          : root === "packages/tool-results"
            ? [
                {
                  include: TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity.module,
                },
                {
                  include: BLOB_TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity.module,
                },
              ]
            : root === "apps/core"
              ? [
                  {
                    include: "src/conversation/thread-summary-persistence-codec.ts",
                  },
                  { include: "src/transcript/transcript-persistence-codec.ts" },
                  { include: "src/surface/bridge/agent-run-journal/index.ts" },
                  { include: "src/migration/frozen-graceful-restart-store.ts" },
                  {
                    include: "src/workflow/workflow-artifact-persistence-codec.ts",
                  },
                  { include: "src/workflow/workflow-persistence-codec.ts" },
                  {
                    include: CORE_ANTHROPIC_FALLBACK_CACHE_PERSISTED_CODEC.identity.module,
                  },
                ]
              : root === "packages/mini-lilac-runtime"
                ? [
                    { include: "src/workspace-history-persistence-codec.ts" },
                    { include: "src/sqlite-persistence-codec.ts" },
                    { include: "src/sqlite-history-persistence-codec.ts" },
                    { include: "src/sqlite-todo-persistence-codec.ts" },
                  ]
                : root === "packages/utils"
                  ? [
                      {
                        include: UTILS_CODEX_TOKENS_PERSISTED_CODEC.identity.module,
                      },
                    ]
                  : [],
    "architecture/sqlite-transaction-adapter-contract":
      root === "packages/utils" ? [{ include: "persistence.ts" }] : [],
    "architecture/sqlite-transaction-consumer":
      root === "apps/core"
        ? [
            ...new Set(CORE_SQLITE_TRANSACTION_CONSUMERS.map(({ identity }) => identity.module)),
          ].map((include) => ({ include }))
        : root === "packages/mini-lilac-runtime"
          ? [
              ...new Set(MINI_SQLITE_TRANSACTION_CONSUMERS.map(({ identity }) => identity.module)),
            ].map((include) => ({ include }))
          : [],
    "architecture/no-result-err-in-sqlite-callback":
      root === "apps/core"
        ? [
            { include: "src/conversation/thread-store.ts" },
            { include: "src/question/question-store.ts" },
            { include: "scripts/legacy-graceful-restart-blob-migration.ts" },
            { include: "src/surface/bridge/agent-run-journal/index.ts" },
            { include: "src/surface/bridge/request-delivery/sqlite-store.ts" },
            { include: "src/transcript/transcript-store.ts" },
            { include: "src/workflow/durable-workflow-store.ts" },
            { include: "src/workflow/workflow-migrations.ts" },
          ]
        : root === "packages/mini-lilac-runtime"
          ? [{ include: "src/sqlite-store.ts" }]
          : root === "packages/utils"
            ? [{ include: "persistence.ts" }]
            : [],
    "architecture/raw-event-message-boundary":
      root === "packages/event-bus"
        ? [{ include: "raw-bus.ts" }, { include: "redis-streams-bus.ts" }]
        : [],
    "architecture/event-handler-result":
      root === "packages/event-bus" ? [{ include: "lilac-bus.ts" }] : [],
    "architecture/event-delivery-policy-exhaustiveness":
      root === "packages/event-bus" ? [{ include: "event-delivery.ts" }] : [],
  };
  return {
    ...EMPTY_POLICY,
    ruleZones,
    eventCodecRegistries: root === "packages/event-bus" ? [EVENT_BUS_CODEC_REGISTRY] : [],
    toolCodecRegistries: root === "apps/mini-lilac-tui" ? [TUI_TOOL_CODEC_REGISTRY] : [],
    resultDecoders:
      root === "apps/mini-lilac-tui"
        ? [TUI_RESULT_DECODER]
        : root === "packages/mini-lilac-runtime"
          ? [MINI_SQLITE_MIGRATION_RUN_RESULT_DECODER]
          : (WAVE_2_RESULT_DECODERS.get(root) ?? []),
    unknownFreeModules: root === "apps/mini-lilac-tui" ? TUI_UNKNOWN_FREE_MODULES : [],
    persistedCodecs:
      root === "apps/acp-controller"
        ? [
            ACP_RUN_RECORD_PERSISTED_CODEC,
            ACP_RUN_CANCELLATION_PERSISTED_CODEC,
            ACP_SESSION_INDEX_PERSISTED_CODEC,
          ]
        : root === "apps/mini-lilac-tui"
          ? [TUI_BINDING_PREFERENCES_PERSISTED_CODEC]
          : root === "packages/tool-results"
            ? [TOOL_RESULT_ARTIFACT_METADATA_CODEC, BLOB_TOOL_RESULT_ARTIFACT_METADATA_CODEC]
            : root === "packages/utils"
              ? [UTILS_CODEX_TOKENS_PERSISTED_CODEC]
              : root === "apps/core"
                ? [
                    ...CORE_THREAD_PERSISTED_CODECS,
                    ...CORE_TRANSCRIPT_PERSISTED_CODECS,
                    CORE_RESOURCE_PERSISTED_CODEC,
                    CORE_AGENT_RUN_OPENED_PERSISTED_CODEC,
                    CORE_AGENT_RUN_CHECKPOINT_PERSISTED_CODEC,
                    CORE_AGENT_RUN_TERMINAL_PERSISTED_CODEC,
                    CORE_GRACEFUL_RESTART_PERSISTED_CODEC,
                    CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC,
                    CORE_WORKFLOW_ROW_PERSISTED_CODEC,
                    CORE_ANTHROPIC_FALLBACK_CACHE_PERSISTED_CODEC,
                  ]
                : root === "packages/mini-lilac-runtime"
                  ? [
                      ...MINI_WORKSPACE_HISTORY_PERSISTED_CODECS,
                      ...MINI_SQLITE_TRANSCRIPT_PERSISTED_CODECS,
                      MINI_SQLITE_TODO_PERSISTED_CODEC,
                      MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC,
                    ]
                  : [],
    persistedStoreConsumers:
      root === "apps/acp-controller"
        ? ACP_PERSISTED_CONSUMERS
        : root === "apps/mini-lilac-tui"
          ? [TUI_BINDING_PREFERENCES_PERSISTED_CONSUMER]
          : root === "packages/tool-results"
            ? [TOOL_RESULT_ARTIFACT_METADATA_CONSUMER, BLOB_TOOL_RESULT_ARTIFACT_METADATA_CONSUMER]
            : root === "packages/utils"
              ? [UTILS_CODEX_TOKENS_PERSISTED_CONSUMER]
              : root === "apps/core"
                ? [
                    ...CORE_THREAD_PERSISTED_CONSUMERS,
                    ...CORE_TRANSCRIPT_PERSISTED_CONSUMERS,
                    CORE_CLAUDE_ATTEMPT_PERSISTED_CONSUMER,
                    CORE_RESOURCE_PERSISTED_CONSUMER,
                    CORE_AGENT_RUN_JOURNAL_PERSISTED_CONSUMER,
                    CORE_AGENT_RUN_OPENED_EVENT_PERSISTED_CONSUMER,
                    CORE_AGENT_RUN_PREVIOUS_CHECKPOINT_PERSISTED_CONSUMER,
                    ...CORE_AGENT_RUN_JOURNAL_ENCODER_CONSUMERS,
                    CORE_LEGACY_GRACEFUL_RESTART_PERSISTED_CONSUMER,
                    CORE_WORKFLOW_ARTIFACT_PERSISTED_CONSUMER,
                    CORE_LEGACY_WORKFLOW_BLOB_MIGRATION_PERSISTED_CONSUMER,
                    CORE_ANTHROPIC_FALLBACK_CACHE_PERSISTED_CONSUMER,
                    ...CORE_WORKFLOW_ROW_PERSISTED_CONSUMERS,
                  ]
                : root === "packages/mini-lilac-runtime"
                  ? [
                      ...MINI_WORKSPACE_HISTORY_PERSISTED_CONSUMERS,
                      ...MINI_SQLITE_TRANSCRIPT_PERSISTED_CONSUMERS,
                      MINI_SQLITE_TODO_PERSISTED_CONSUMER,
                      MINI_SQLITE_TODO_STORE_PERSISTED_CONSUMER,
                      MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CONSUMER,
                      ...MINI_SQLITE_STRUCTURAL_HISTORY_ROWS_PERSISTED_CONSUMERS,
                      MINI_SQLITE_HISTORY_RECOVERY_PERSISTED_CONSUMER,
                    ]
                  : [],
    sqliteTransactionAdapters:
      root === "packages/utils"
        ? [
            {
              identity: {
                module: "persistence.ts",
                exportName: "runBunSqliteTransaction",
              },
              databaseParameter: 0,
              operationParameter: 1,
              rollbackSentinel: {
                module: "persistence.ts",
                exportName: "BunSqliteRollbackSentinel",
              },
              panicClassifier: {
                package: "better-result",
                exportName: "Panic.is",
              },
              driverErrorClassifier: {
                module: "persistence.ts",
                exportName: "classifyBunSqliteDriverFailure",
              },
            },
          ]
        : [],
    sqliteTransactionConsumers:
      root === "apps/core"
        ? CORE_SQLITE_TRANSACTION_CONSUMERS
        : root === "packages/mini-lilac-runtime"
          ? MINI_SQLITE_TRANSACTION_CONSUMERS
          : [],
    rawEventMessageBoundaries:
      root === "packages/event-bus"
        ? [
            {
              identity: {
                module: "raw-bus.ts",
                exportName: "RawBus.subscribe",
              },
              messageType: {
                package: "@stanley2058/lilac-event-bus",
                exportName: "Message",
              },
              handlerParameter: 2,
              messageParameter: 0,
              contextParameter: 1,
            },
            {
              identity: {
                module: "redis-streams-bus.ts",
                exportName: "RedisStreamsBus.subscribe",
              },
              messageType: {
                package: "@stanley2058/lilac-event-bus",
                exportName: "Message",
              },
              handlerParameter: 2,
              messageParameter: 0,
              contextParameter: 1,
            },
          ]
        : [],
    eventDeliveryApis:
      root === "packages/event-bus"
        ? [
            {
              identity: {
                module: "lilac-bus.ts",
                exportName: "LilacBus.subscribeTopic",
              },
              handlerParameter: 2,
              handlerMessageParameter: 0,
              handlerContextParameter: 1,
              deliveryPolicy: {
                module: "event-delivery.ts",
                exportName: "applyEventDeliveryPolicy",
              },
              deliveryErrorParameter: 0,
            },
          ]
        : [],
    eventDeliveryConsumers: root === "apps/core" ? CORE_EVENT_DELIVERY_CONSUMERS : [],
    compatibilityOutputs:
      root === "apps/core"
        ? [
            {
              sink: {
                kind: "local",
                module: "src/tool-server/create-tool-server.ts",
                exportName: "createToolServer.post.<callback@2>@2",
              },
              category: "http",
              reason:
                "Projects Level-2 Results to the established strict Core tool-server wire envelope.",
            },
          ]
        : [],
    boundaryDecoders: [
      ...(root === "packages/plugin-runtime"
        ? ([
            ...[
              "ToolInputValidationError.constructor",
              "summarizeProvidedKeys",
              "isEmptyObjectInput",
              "formatToolValidationError",
              "decodeToolInput",
              "parseToolInput",
              "parseToolInputPreservingZodError",
            ].map((exportName) => ({
              identity: { module: "validation-error-message.ts", exportName },
              category: "request" as const,
            })),
            ...[
              "collectVariants",
              "conditionToText",
              "getObjectShape",
              "formatAggregatedFieldLine.<callback>",
              "mergeConditions",
              "extractLiteralValues",
              "renderType",
            ].map((exportName) => ({
              identity: { module: "zod-cli.ts", exportName },
              category: "plugin" as const,
            })),
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(root === "packages/event-bus"
        ? ([
            ...[
              "boundWireValue",
              "boundWireEvidence",
              "redisTransportEvidence",
              "decodeRedisFields",
              "decodeMessage",
              "transform.<callback@1>@1",
              "transform.<callback@1>@2",
              "transform.<callback@1>@5",
            ].map((exportName) => ({
              identity: { module: "redis-streams-bus.ts", exportName },
              category: "wire" as const,
            })),
            ...["decodeSchema", "decodeKnownMessage"].map((exportName) => ({
              identity: { module: "lilac-codecs.ts", exportName },
              category: "wire" as const,
            })),
            ...[
              "decodeRedisEventDeadLetterCiphertextEnvelope",
              "decryptRedisEventDeadLetterRecord",
            ].map((exportName) => ({
              identity: { module: "redis-event-dead-letter.ts", exportName },
              category: "persistence" as const,
            })),
            {
              identity: {
                module: "lilac-spec.ts",
                exportName: "parseCmdRequestMessageData",
              },
              category: "wire" as const,
            },
            {
              identity: {
                module: "core-primary-lineage.ts",
                exportName: "decodeCorePrimaryLineageV2",
              },
              category: "projection" as const,
            },
            {
              identity: {
                module: "core-primary-lineage.ts",
                exportName: "normalizeResolvedCanonicalMessages",
              },
              category: "projection" as const,
            },
            {
              identity: {
                module: "lilac-spec.ts",
                exportName: "findManagedInlineData",
              },
              category: "wire" as const,
            },
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(root === "packages/tool-results"
        ? ([
            {
              identity: TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity,
              category: "persistence",
            },
            {
              identity: BLOB_TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity,
              category: "persistence",
            },
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(root === "packages/agent"
        ? ([
            {
              identity: {
                module: "ai-sdk-pi-agent.ts",
                exportName: "repairLegacyBatchInput",
              },
              category: "request",
            },
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(root === "packages/claude-code-bridge"
        ? ([
            {
              identity: {
                module: "claude-code-tools.ts",
                exportName: "normalizeLegacyBatchArguments",
              },
              category: "request",
            },
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(root === "packages/mini-lilac-runtime"
        ? ([
            ...MINI_WORKSPACE_HISTORY_PERSISTED_CODECS.map(({ identity }) => ({
              identity,
              category: "persistence" as const,
            })),
            ...MINI_SQLITE_BOUNDARY_DECODER_IDENTITIES.map((identity) => ({
              identity,
              category: "persistence" as const,
            })),
            {
              identity: MINI_SQLITE_TODO_PERSISTED_CODEC.identity,
              category: "persistence" as const,
            },
            {
              identity: {
                module: "src/workspace-history-persistence-codec.ts",
                exportName: "detectFormatVersion",
              },
              category: "persistence" as const,
            },
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(root === "apps/core"
        ? ([
            ...[
              "decodeConversationThreadStringArray",
              "decodeConversationThreadImportance",
              "decodeConversationThreadAboutness",
              "decodeConversationThreadSummaryRow",
            ].map((exportName) => ({
              identity: {
                module: "src/conversation/thread-summary-persistence-codec.ts",
                exportName,
              },
              category: "persistence" as const,
            })),
            ...[
              "decodeSerialized",
              "decodeNormalizedMessagesValue",
              "decodeTranscriptMessages",
              "decodeTranscriptCompactionContext",
              "decodeTranscriptProviderState",
              "decodeTranscriptRow",
              "decodeCoreSurfaceProjectionRow",
              "decodeCoreLineageManifestRow",
              "decodeRecentAgentWriteRow",
              "decodeDiscoveryRecordRow",
              "decodeSurfaceMessageLinkRow",
              "normalizeResourceRecordV1",
              "normalizeResourceCacheV1",
              "normalizeResourceDetectedMediaType",
              "decodeResourceRecordRow",
            ].map((exportName) => ({
              identity: {
                module: "src/transcript/transcript-persistence-codec.ts",
                exportName,
              },
              category: "persistence" as const,
            })),
            {
              identity: {
                module: "src/conversation/thread-materializer-worker.ts",
                exportName: "startConversationThreadMaterializer.postRequest",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/transcript/transcript-store.ts",
                exportName: "SqliteTranscriptStore.emitPersistenceDiagnosticsAfterTransaction",
              },
              category: "projection",
            },
            ...[
              ["src/conversation/thread-store.ts", "signalConversationThreadStoreDefect"],
              ["src/conversation/thread-store.ts", "ConversationThreadStore.loadVectorExtension"],
              ["src/conversation/thread-store.ts", "ConversationThreadStore.attachSurfaceDb"],
              [
                "src/conversation/thread-store.ts",
                "ConversationThreadStore.hasRequiredSurfaceTables",
              ],
              ["src/conversation/thread-service.ts", "signalConversationThreadDefect"],
              ["src/conversation/thread-service.ts", "classifyConversationThreadGenerationFailure"],
              ["src/conversation/thread-service.ts", "captureConversationThreadSqliteOperation"],
              ["src/conversation/thread-service.ts", "parseConversationThreadJson"],
              ["src/surface/bridge/bridge-log.ts", "formatBridgeTaggedErrorForLog"],
              ["src/surface/bridge/bus-agent-runner.ts", "formatBusAgentRunnerDrainFailureForLog"],
            ].map(([module, exportName]) => ({
              identity: { module, exportName },
              category: "projection" as const,
            })),
            {
              identity: CORE_GRACEFUL_RESTART_PERSISTED_CODEC.identity,
              category: "persistence",
            },
            {
              identity: CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC.identity,
              category: "persistence",
            },
            ...[
              "decodeJsonField",
              "decodeWorkflowRevisionRow",
              "decodeWorkflowRunRow",
              "decodeWorkflowOperationRow",
              "decodeWorkflowWaitRow",
              "decodeWorkflowTriggerRow",
              "decodeWorkflowSurfaceBindingRow",
              "decodeWorkflowSurfaceActionRow",
              "decodeWorkflowRequestDispatchRow",
              "decodeWorkflowRequestTerminalReceiptRow",
              "decodeWorkflowActionOutboxRow",
              "decodeWorkflowLegacyAuditRow",
              "decodeWorkflowArtifactRow",
              "decodeWorkflowPersistenceRow",
            ].map((exportName) => ({
              identity: {
                module: "src/workflow/workflow-persistence-codec.ts",
                exportName,
              },
              category: "persistence" as const,
            })),
            {
              identity: {
                module: "src/workflow/workflow-migrations.ts",
                exportName: "decodeStagedWorkflowArtifactReference",
              },
              category: "persistence",
            },
            {
              identity: {
                module: "src/mcp/config-file.ts",
                exportName: "isMissingFileError",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/mcp/config-file.ts",
                exportName: "validateMutationServerId",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/mcp/value-source.ts",
                exportName: "decodeJsonValue",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/mcp/registry.ts",
                exportName: "decodeMcpServerInfo",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/tools/fs/remote-fs.ts",
                exportName: "decodeRemoteFsRunnerPackageSpec",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/workflow/workflow-action-resolver.ts",
                exportName: "decodeWorkflowActionOutboxEvent",
              },
              category: "persistence",
            },
            {
              identity: {
                module: "src/workflow/workflow-action-resolver.ts",
                exportName: "decodeWorkflowSurfaceAction",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/surface/bridge/bus-agent-runner/raw.ts",
                exportName: "parseRequestControlFromRaw",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/surface/discord/discord-request-router/common.ts",
                exportName: "getDiscordFlags",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/custom-commands/manager.ts",
                exportName: "decodeCustomCommandModule",
              },
              category: "plugin",
            },
            {
              identity: {
                module: "src/shared/req-context.ts",
                exportName: "decodeRequiredRequestContext",
              },
              category: "request",
            },
            {
              identity: {
                module: "src/shared/req-context.ts",
                exportName: "requireRequestContext",
              },
              category: "request",
            },
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(root === "packages/blob-storage"
        ? ([
            {
              identity: {
                module: "src/local-backend.ts",
                exportName: "classifyLocalFileCause",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/backend.ts",
                exportName: "classifyAdapterErrorDetails",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/local-backend.ts",
                exportName: "normalizeNodeFileReadableStream",
              },
              category: "projection",
            },
            ...[
              "decodeReservation",
              "referenceIssues",
              "handleIssues",
              "SupervisedBlobStore.startUpload",
              "SupervisedBlobStore.open",
              "SupervisedBlobStore.delete",
            ].map((exportName) => ({
              identity: { module: "src/store.ts", exportName },
              category: "persistence" as const,
            })),
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(INTEGRATED_BOUNDARY_DECODERS.get(root) ?? []),
    ],
    openProtocolAdapters: INTEGRATED_OPEN_PROTOCOL_ADAPTERS.get(root) ?? [],
    opaqueUnknown: [
      ...(root === "packages/event-bus"
        ? ([
            {
              identity: {
                module: "event-dead-letter.ts",
                exportName: "captureDeadLetterAcceptance.catch",
              },
              reason: "Preserves an opaque Redis adapter exception as dead-letter failure cause.",
            },
            {
              identity: {
                module: "event-delivery.ts",
                exportName: "EventDeliveryFatalReporter.report",
              },
              reason:
                "The fatal reporter contract carries an opaque rejected value to the registered defect supervisor.",
            },
            {
              identity: {
                module: "redis-streams-bus.ts",
                exportName: "RedisStreamsBus.subscribe.reportFatal",
              },
              reason: "Reports an opaque handler or dependency defect without domain inspection.",
            },
            {
              identity: {
                module: "redis-streams-bus.ts",
                exportName: "RedisStreamsBus.subscribe.readFailure",
              },
              reason: "Preserves an opaque Redis read exception as a transport failure cause.",
            },
          ] satisfies readonly ReasonedSymbolException[])
        : []),
      ...(root === "apps/core"
        ? [
            {
              identity: {
                module: "src/mcp/config-file.ts",
                exportName: "errorMessage",
              },
              reason: "Formats an opaque external exception without inspecting domain structure.",
            },
            {
              identity: {
                module: "src/mcp/value-source.ts",
                exportName: "errorMessage",
              },
              reason: "Formats an opaque external exception without inspecting domain structure.",
            },
            {
              identity: {
                module: "src/migration/frozen-graceful-restart-store.ts",
                exportName: "isOpaqueSuperJsonValue",
              },
              reason:
                "Checks only whether an opaque restart value has a SuperJSON-compatible outer JavaScript type before capability validation.",
            },
            {
              identity: {
                module: "src/mcp/error-format.ts",
                exportName: "safeMcpErrorText",
              },
              reason:
                "Redacts and bounds an opaque external exception for the compatibility response.",
            },
            {
              identity: {
                module: "src/mcp/error-format.ts",
                exportName: "opaqueErrorMessage",
              },
              reason: "Formats an opaque external exception without inspecting domain structure.",
            },
            ...[
              ["build-remote-runner.ts", "captureBuildOperation.catch"],
              ["src/discovery/discovery-service.ts", "DiscoveryService.searchResult.catch"],
              ["src/discovery/discovery-service.ts", "DiscoveryService.closeResult.catch"],
              ["src/heartbeat/heartbeat-service.ts", "reloadHeartbeatCoreConfig"],
              ["src/heartbeat/heartbeat-service.ts", "computeHeartbeatCronAtMs"],
              ["src/shared/agent-output-activity.ts", "createAgentOutputActivityPublisher"],
              [
                "src/shared/agent-output-activity.ts",
                "createAgentOutputActivityPublisher.<callback>.<callback>",
              ],
            ].map(([module, exportName]) => ({
              identity: { module: module!, exportName: exportName! },
              reason:
                "Carries one opaque external rejection only at its immediate adapter boundary.",
            })),
            ...["opaqueErrorCause", "opaqueErrorMessage"].map((exportName) => ({
              identity: {
                module: "src/ssh/remote-js/remote-runner-utils.ts",
                exportName,
              },
              reason: "Carries or formats only an opaque bundled-runner exception value.",
            })),
          ]
        : []),
      ...(root === "packages/mini-lilac-runtime"
        ? [
            {
              identity: {
                module: "src/session-service.ts",
                exportName: "mapMiniLilacPersistenceFailure",
              },
              reason:
                "Classifies an opaque caught persistence exception without treating it as domain data.",
            },
          ]
        : []),
      ...(INTEGRATED_OPAQUE_UNKNOWN.get(root) ?? []),
    ],
    capabilityPredicates: [
      ...(root === "apps/core"
        ? [
            {
              identity: {
                module: "src/shared/sqlite.ts",
                exportName: "isSqliteBusyError",
              },
              reason: "Checks only the SQLite busy/locked error-message capability.",
            },
            {
              identity: {
                module: "src/shared/is-adapter-platform.ts",
                exportName: "isAdapterPlatform",
              },
              reason: "Checks exact membership in the closed adapter platform string union.",
            },
            {
              identity: {
                module: "src/surface/adapter.ts",
                exportName: "hasSurfaceGuildIdResolver",
              },
              reason:
                "Checks the exact optional Discord guild lookup capability preserved by the descriptor-bound facade.",
            },
            {
              identity: {
                module: "src/ssh/remote-js/remote-runner-utils.ts",
                exportName: "isPanic",
              },
              reason: "Checks only the exact better-result Panic brand in the isolated bundle.",
            },
            ...["requiredString", "requiredTimestamp"].map((exportName) => ({
              identity: {
                module: "src/surface/bridge/request-delivery/sqlite-store.ts",
                exportName,
              },
              reason:
                "Checks one primitive SQLite field capability before constructing a typed request-delivery record.",
            })),
            {
              identity: {
                module: "scripts/legacy-transcript-blob-migration.ts",
                exportName: "isDecodeFailure",
              },
              reason:
                "Checks the exact migration-owned decode-failure discriminant before legacy blob inspection continues.",
            },
            {
              identity: {
                module: "scripts/legacy-graceful-restart-blob-migration.ts",
                exportName: "isFormerOpaqueSuperJsonValue",
              },
              reason:
                "Checks only whether a former restart value has a SuperJSON-compatible outer JavaScript type before migration validation.",
            },
          ]
        : []),
      ...(INTEGRATED_CAPABILITY_PREDICATES.get(root) ?? []),
    ],
    exceptionAdapters: [
      ...(REVIEWED_EXCEPTION_ADAPTERS[root] ?? []),
      ...(PRECISE_EXCEPTION_IDENTITIES[root] ?? []).map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "compatibility" as const,
        externalApi: {
          package: "global",
          exportName: "language host failure signal",
        },
        direction: "signal-host" as const,
        reason: "Signals an owned failure through this exact callable's host contract.",
      })),
    ],
    structuredLoggers:
      root === "apps/core"
        ? [
            "debug",
            "error",
            "fatal",
            "info",
            "log",
            "logDebug",
            "logError",
            "logFatal",
            "logInfo",
            "logWarn",
            "warn",
          ].map((exportName) => ({
            sink: {
              kind: "external" as const,
              package: "@stanley2058/simple-module-logger",
              exportName,
            },
            reason: "Core logger arguments are generically serialized in text or JSONL output.",
          }))
        : [],
    operationalResultApis: [
      ...(WAVE_3_OPERATIONAL_RESULT_APIS.get(root) ?? []),
      ...(root === "apps/core"
        ? [
            {
              module: "src/tool-server/client-arguments.ts",
              exportName: "applyToolPositionals",
            },
            ...["resolveDiscordReferencedMessage", "resolveDiscordReferencedMessages"].map(
              (exportName) => ({
                module: "src/surface/discord/discord-reference-enrichment.ts",
                exportName,
              }),
            ),
            ...["captureBuildOperation", "buildRemoteRunner"].map((exportName) => ({
              module: "build-remote-runner.ts",
              exportName,
            })),
            ...[
              "parsePositiveInt",
              "parseBackend",
              "parseBenchmarkArgs",
              "countGlobResult",
              "countGrepResult",
              "runCase",
              "runBenchmark",
            ].map((exportName) => ({
              module: "scripts/bench-fs-search.ts",
              exportName,
            })),
            ...[
              "parseRelativeDurationMs",
              "parseEpochMs",
              "resolveOffsetTimeMs",
              "resolveLookbackDurationMs",
              "resolveTimeWindow",
              "DiscoveryService.searchResult",
              "DiscoveryService.closeResult",
            ].map((exportName) => ({
              module: "src/discovery/discovery-service.ts",
              exportName,
            })),
            ...["reloadHeartbeatCoreConfig", "computeHeartbeatCronAtMs"].map((exportName) => ({
              module: "src/heartbeat/heartbeat-service.ts",
              exportName,
            })),
            {
              module: "src/shared/req-context.ts",
              exportName: "decodeRequiredRequestContext",
            },
            {
              module: "src/shared/tool-server-context.ts",
              exportName: "decodeToolServerHeaders",
            },
            ...["resolveToolPathForRequestContextResult", "decodeDataUrlResult"].map(
              (exportName) => ({
                module: "src/shared/attachment-utils.ts",
                exportName,
              }),
            ),
            ...["readConfiguredSshHostsResult", "requireConfiguredSshHostResult"].map(
              (exportName) => ({
                module: "src/ssh/ssh-config.ts",
                exportName,
              }),
            ),
            {
              module: "src/tool-server/tools/programmatic-workflow.ts",
              exportName: "decodeWorkflowJsonObject",
            },
            {
              module: "src/tool-server/tools/ssh.ts",
              exportName: "decodeSshProbeOutput",
            },
            {
              module: "src/tool-server/tools/web-search/firecrawl-web-search-provider.ts",
              exportName: "decodeFirecrawlSearchResponse",
            },
            {
              module: "src/tool-server/tools/web-search/firecrawl-permit-pool.ts",
              exportName: "FirecrawlPermitPool.acquire",
            },
            {
              module: "src/tool-server/tools/web/provider-page-extraction.ts",
              exportName: "decodeFirecrawlScrapeResponse",
            },
            {
              module: "src/tool-server/tools/onboarding.ts",
              exportName: "decodeGithubReleaseResponse",
            },
            ...[
              "decodeThreadMaterializerWorkerRequest",
              "decodeThreadMaterializerWorkerResponse",
            ].map((exportName) => ({
              module: "src/conversation/thread-materializer-worker-protocol.ts",
              exportName,
            })),
            ...["decodeGithubAppSecret", "readGithubAppSecretResult"].map((exportName) => ({
              module: "src/github/github-app.ts",
              exportName,
            })),
            {
              module: "src/github/github-api.ts",
              exportName: "decodeGithubApiErrorResponse",
            },
            ...["decodeGithubUserTokenSecret", "readGithubUserTokenSecretResult"].map(
              (exportName) => ({
                module: "src/github/github-user-token.ts",
                exportName,
              }),
            ),
            ...["captureGithubWebhookOperation", "superviseGithubWebhookHandler"].map(
              (exportName) => ({
                module: "src/github/webhook/github-webhook-server.ts",
                exportName,
              }),
            ),
            ...CORE_THREAD_PERSISTED_CODECS.map(({ identity }) => identity),
            ...CORE_THREAD_PERSISTED_CONSUMERS.map(({ identity }) => identity),
            ...CORE_TRANSCRIPT_PERSISTED_CODECS.map(({ identity }) => identity),
            ...CORE_TRANSCRIPT_PERSISTED_CONSUMERS.map(({ identity }) => identity),
            CORE_CLAUDE_ATTEMPT_PERSISTED_CONSUMER.identity,
            {
              module: "src/transcript/claude-attempt-lifecycle.ts",
              exportName: "CoreClaudeAttemptLifecycle.recordOutcome",
            },
            CORE_RESOURCE_PERSISTED_CODEC.identity,
            CORE_RESOURCE_PERSISTED_CONSUMER.identity,
            CORE_AGENT_RUN_OPENED_PERSISTED_CODEC.identity,
            CORE_AGENT_RUN_CHECKPOINT_PERSISTED_CODEC.identity,
            CORE_AGENT_RUN_TERMINAL_PERSISTED_CODEC.identity,
            CORE_AGENT_RUN_JOURNAL_PERSISTED_CONSUMER.identity,
            CORE_AGENT_RUN_OPENED_EVENT_PERSISTED_CONSUMER.identity,
            CORE_AGENT_RUN_PREVIOUS_CHECKPOINT_PERSISTED_CONSUMER.identity,
            ...CORE_AGENT_RUN_JOURNAL_ENCODER_CONSUMERS.map(({ identity }) => identity),
            CORE_GRACEFUL_RESTART_PERSISTED_CODEC.identity,
            CORE_LEGACY_GRACEFUL_RESTART_PERSISTED_CONSUMER.identity,
            CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC.identity,
            CORE_WORKFLOW_ROW_PERSISTED_CODEC.identity,
            CORE_WORKFLOW_ARTIFACT_PERSISTED_CONSUMER.identity,
            CORE_ANTHROPIC_FALLBACK_CACHE_PERSISTED_CODEC.identity,
            CORE_ANTHROPIC_FALLBACK_CACHE_PERSISTED_CONSUMER.identity,
            ...CORE_WORKFLOW_ROW_PERSISTED_CONSUMERS.map(({ identity }) => identity),
            ...CORE_WORKFLOW_STORE_READ_RESULT_APIS,
            {
              module: "src/workflow/workflow-artifact-store.ts",
              exportName: "writeWorkflowValueArtifact",
            },
            ...CORE_SQLITE_TRANSACTION_CONSUMERS.map(({ identity }) => identity),
            ...[
              "SqliteTranscriptStore.getCoreNamedClaudeSessionBinding",
              "SqliteTranscriptStore.readCoreNamedClaudeSessionBinding",
              "SqliteTranscriptStore.getCorePrimaryClaudeSessionBinding",
              "SqliteTranscriptStore.readCorePrimaryClaudeSessionBinding",
            ].map((exportName) => ({
              module: "src/transcript/transcript-store.ts",
              exportName,
            })),
            {
              module: "src/conversation/thread-service.ts",
              exportName: "ConversationThreadService.search",
            },
            {
              module: "src/conversation/thread-service.ts",
              exportName: "ConversationThreadService.read",
            },
            {
              module: "src/conversation/thread-service.ts",
              exportName: "ConversationThreadService.metadata",
            },
            {
              module: "src/surface/bridge/bus-agent-runner.ts",
              exportName: "startBusAgentRunner.handleCmdRequestMessage",
            },
            ...[
              ["src/tool-server/tools/attachment.ts", "Attachment.call"],
              ["src/tool-server/tools/attachment.ts", "downloadLegacyBlobToBuffer"],
              ["src/tool-server/tools/codex.ts", "Codex.call"],
              ["src/tool-server/tools/content-inspect.ts", "ContentInspect.call"],
              ["src/tool-server/tools/conversation-thread.ts", "ConversationThread.call"],
              ["src/tool-server/tools/discovery.ts", "Discovery.call"],
              ["src/tool-server/tools/generate.ts", "Generate.call"],
              ["src/tool-server/tools/mcp.ts", "McpManagement.call"],
              ["src/tool-server/tools/onboarding.ts", "Onboarding.call"],
              ["src/tool-server/tools/programmatic-workflow.ts", "ProgrammaticWorkflow.call"],
              ["src/tool-server/tools/resource.ts", "Resource.call"],
              ["src/tool-server/tools/skills.ts", "Skills.call"],
              ["src/tool-server/tools/ssh.ts", "SSH.call"],
              ["src/tool-server/tools/surface.ts", "Surface.call"],
              ["src/tool-server/tools/web.ts", "Web.call"],
            ].map(([module, exportName]) => ({
              module: module!,
              exportName: exportName!,
            })),
          ]
        : []),
      ...(root === "packages/plugin-runtime"
        ? [
            {
              module: "validation-error-message.ts",
              exportName: "decodeToolInput",
            },
            {
              module: "server-tool-result.ts",
              exportName: "decodeServerToolResult",
            },
            {
              module: "define-server-tool.ts",
              exportName: "createCallable.<callback>.invoke",
            },
            {
              module: "define-server-tool.ts",
              exportName: "lookupServerToolCallable",
            },
            {
              module: "define-server-tool.ts",
              exportName: "defineServerTool.call",
            },
            { module: "hooks.ts", exportName: "invokeLevel2Call" },
            { module: "types.ts", exportName: "ServerTool.call" },
          ]
        : []),
      ...(root === "packages/tool-results"
        ? [
            TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity,
            TOOL_RESULT_ARTIFACT_METADATA_CONSUMER.identity,
            BLOB_TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity,
            BLOB_TOOL_RESULT_ARTIFACT_METADATA_CONSUMER.identity,
            ...[
              "init",
              "create",
              "createFromFile",
              "createFromStream",
              "read",
              "readWindow",
              "maintain",
            ].map((method) => ({
              module: "src/tool-result-artifact-store.ts",
              exportName: `createToolResultArtifactStore.${method}`,
            })),
            ...[
              "init",
              "create",
              "createFromFile",
              "createFromStream",
              "read",
              "readWindow",
              "maintain",
            ].map((method) => ({
              module: "src/blob-tool-result-artifact-store.ts",
              exportName: `createBlobBackedToolResultArtifactStore.${method}`,
            })),
          ]
        : []),
      ...(root === "packages/mini-lilac-runtime"
        ? [
            ...MINI_RUNTIME_OPERATIONAL_RESULT_APIS,
            ...MINI_SQLITE_TRANSACTION_CONSUMERS.map(({ identity }) => identity),
            ...MINI_WORKSPACE_HISTORY_PERSISTED_CODECS.map(({ identity }) => identity),
            ...MINI_WORKSPACE_HISTORY_PERSISTED_CONSUMERS.map(({ identity }) => identity),
            ...MINI_SQLITE_BOUNDARY_DECODER_IDENTITIES,
            ...MINI_SQLITE_TRANSCRIPT_PERSISTED_CONSUMERS.map(({ identity }) => identity),
            ...MINI_SQLITE_STORE_RESULT_APIS,
            ...MINI_SESSION_SERVICE_RESULT_APIS,
            MINI_SQLITE_TODO_PERSISTED_CODEC.identity,
            MINI_SQLITE_TODO_PERSISTED_CONSUMER.identity,
            MINI_SQLITE_TODO_STORE_PERSISTED_CONSUMER.identity,
          ]
        : []),
      ...(root === "packages/utils"
        ? [{ module: "persistence.ts", exportName: "runBunSqliteTransaction" }]
        : []),
      ...(root === "packages/claude-code-bridge"
        ? [
            {
              module: "claude-code-run.ts",
              exportName: "MaterializedClaudeCodeRun.createUtilityModelResult",
            },
          ]
        : []),
      ...(root === "apps/mini-lilac-tui"
        ? [
            {
              module: "src/tool-observation-projection.ts",
              exportName: "decodeKnownToolObservation",
            },
          ]
        : []),
      ...(root === "apps/core"
        ? [
            {
              module: "src/mcp/config-file.ts",
              exportName: "readMcpConfigFile",
            },
            {
              module: "src/mcp/config-file.ts",
              exportName: "writeMcpConfigFileAtomic",
            },
            {
              module: "src/mcp/config-file.ts",
              exportName: "mutateMcpConfigFile",
            },
            ...[
              "resolveMcpOAuthCredentialPathResult",
              "readMcpOAuthCredentialFileResult",
              "writeMcpOAuthCredentialFileAtomicResult",
              "updateMcpOAuthCredentialFileResult",
            ].map((exportName) => ({
              module: "src/mcp/credential-file.ts",
              exportName,
            })),
            ...[
              "captureOAuthAttempt",
              "McpOAuthProvider.startAuthorizationResult",
              "McpOAuthProvider.completeAuthorizationResult",
              "McpOAuthProvider.createPendingAuthorization",
              "McpOAuthProviderService.startAuthorizationResult",
            ].map((exportName) => ({
              module: "src/mcp/oauth-provider.ts",
              exportName,
            })),
            {
              module: "src/mcp/value-source.ts",
              exportName: "resolveJsonPointer",
            },
            {
              module: "src/mcp/value-source.ts",
              exportName: "resolveMcpValueSource",
            },
            {
              module: "src/mcp/value-source.ts",
              exportName: "resolveMcpValueSourceMap",
            },
            {
              module: "src/mcp/value-source.ts",
              exportName: "validateHttpHeaders",
            },
            {
              module: "src/workflow/workflow-action-resolver.ts",
              exportName: "startWorkflowActionResolver.startWorkflowActionSubscriptionResult",
            },
            {
              module: "src/workflow/workflow-action-resolver.ts",
              exportName: "startWorkflowActionResolver.stopWorkflowActionSubscriptionResult",
            },
            {
              module: "src/workflow/workflow-action-resolver.ts",
              exportName: "captureWorkflowActionOutboxPublication",
            },
            {
              module: "src/workflow/workflow-progress-projector.ts",
              exportName: "WorkflowProgressProjector.startWorkflowProgressSubscriptionResult",
            },
            {
              module: "src/workflow/workflow-progress-projector.ts",
              exportName: "WorkflowProgressProjector.stopWorkflowProgressSubscriptionResult",
            },
            ...[
              "startWorkflowWaitResolverResult",
              "acquireLeaseResult",
              "startWorkflowWaitSubscriptionResult",
              "captureWorkflowWaitResolverTrim",
              "captureWorkflowWaitResolverConsumerGroupRetirement",
              "failWorkflowWaitResolverActivation",
              "activateSubscriptionResult",
              "recoverSubscriptionResult",
              "stopWorkflowWaitSubscriptionResult",
              "stopWorkflowWaitResolverResult",
              "captureWorkflowWaitResolverBarrierPublication",
              "reconcileTimersResult",
              "captureWorkflowWaitResolverWakeupPublication",
            ].map((exportName) => ({
              module: "src/workflow/workflow-wait-resolver.ts",
              exportName: `WorkflowWaitResolver.${exportName}`,
            })),
            {
              module: "src/workflow/workflow-engine.ts",
              exportName: "WorkflowEngine.startWakeSubscription",
            },
            {
              module: "src/workflow/workflow-engine.ts",
              exportName: "runWorkflowTimerTick",
            },
            {
              module: "src/workflow/workflow-engine.ts",
              exportName: "captureWorkflowTerminalReceiptAdoption",
            },
            {
              module: "src/workflow/workflow-engine.ts",
              exportName: "captureWorkflowIdleCancellationPublication",
            },
            {
              module: "src/workflow/workflow-engine.ts",
              exportName: "fetchWorkflowTerminalReceipt",
            },
          ]
        : []),
      ...(STAGE_3_OPERATIONAL_RESULT_APIS.get(root) ?? []),
    ],
    taggedErrorFormatters: [
      ...(root === "apps/core"
        ? [
            {
              kind: "external" as const,
              package: "@stanley2058/lilac-utils",
              exportName: "formatTaggedErrorForLog",
            },
            {
              kind: "local" as const,
              module: "src/tool-server/create-tool-server.ts",
              exportName: "toolServerTaggedErrorLogProjection",
            },
            ...["formatBridgeLogContext", "formatBridgeTaggedErrorForLog"].map((exportName) => ({
              kind: "local" as const,
              module: "src/surface/bridge/bridge-log.ts",
              exportName,
            })),
            {
              kind: "local" as const,
              module: "src/surface/bridge/bus-agent-runner.ts",
              exportName: "formatClaudeLifecycleLogFields",
            },
            {
              kind: "local" as const,
              module: "scripts/migrate-blob-storage.ts",
              exportName: "formatBlobStorageMigrationFailureForLog",
            },
          ]
        : []),
      ...(root === "packages/remote-fs-runner"
        ? ["responseError", "responseSuccess"].map((exportName) => ({
            kind: "local" as const,
            module: "src/cli.ts",
            exportName,
          }))
        : []),
    ],
    name: root,
    packageName,
    root,
    tsconfig: `${root}/tsconfig.json`,
  } satisfies WorkspaceArchitecture;
});

function preciseExceptionAdapterKey(
  workspace: string,
  module: string,
  exportName: string,
  direction: ExceptionAdapter["direction"],
): string {
  return `${workspace}\0${module}\0${exportName}\0${direction}`;
}

const PRECISE_EXCEPTION_ADAPTER_KEYS = new Set(
  Object.entries(PRECISE_EXCEPTION_IDENTITIES).flatMap(([workspace, identities]) =>
    identities.map(([module, exportName]) => {
      const signalDirection = exportName.startsWith("preserve")
        ? ("observe-panic" as const)
        : ("signal-host" as const);
      return preciseExceptionAdapterKey(workspace, module, exportName, signalDirection);
    }),
  ),
);

function exceptionAdapterSyntaxKinds(
  direction: ExceptionAdapter["direction"],
): readonly ExceptionAdapterSyntaxKind[] {
  switch (direction) {
    case "signal-host":
      return ["throw-statement", "host-rejection-call", "registered-host-signal-call"];
    case "observe-panic":
      return ["panic-observation"];
  }
}

function exceptionAdapterProvenance(
  workspace: string,
  adapter: ExceptionAdapter,
): ExceptionAdapterProvenance {
  const { module, exportName } = adapter.identity;
  if (
    PRECISE_EXCEPTION_ADAPTER_KEYS.has(
      preciseExceptionAdapterKey(workspace, module, exportName, adapter.direction),
    )
  ) {
    return "precise-exception-identities";
  }
  if (
    workspace === "apps/core" &&
    adapter.direction === "observe-panic" &&
    CORE_REVIEWED_PANIC_IDENTITIES.some(
      ([candidateModule, candidateExport]) =>
        candidateModule === module && candidateExport === exportName,
    )
  ) {
    return "core-reviewed-panic-identities";
  }
  if (
    workspace === "apps/core" &&
    adapter.direction === "signal-host" &&
    CORE_FATAL_SIGNAL_IDENTITIES.some(
      ([candidateModule, candidateExport]) =>
        candidateModule === module && candidateExport === exportName,
    )
  ) {
    return "core-fatal-signal-identities";
  }
  return "workspace-reviewed-manifest";
}

function exceptionAdapterRelationship(
  workspace: string,
  packageName: string,
  adapter: ExceptionAdapter,
): ExceptionAdapterRelationship {
  if (adapter.externalApi.package === "global") return "language-runtime";
  if (adapter.externalApi.package === "Intl") return "language-runtime";
  if (
    adapter.externalApi.package === "better-result" &&
    adapter.externalApi.exportName === "Panic.is"
  ) {
    return "panic-brand";
  }
  if (
    adapter.direction === "signal-host" &&
    (adapter.category === "result-to-framework" ||
      adapter.category === "rollback" ||
      adapter.category === "defect-supervisor")
  ) {
    return "host-contract";
  }
  return "external-package";
}

export const APPROVED_EXCEPTION_ADAPTER_CATALOG = ARCHITECTURE_WORKSPACES.flatMap((workspace) =>
  workspace.exceptionAdapters.map(
    (adapter): ApprovedExceptionAdapter => ({
      workspace: workspace.name,
      callable: adapter.identity,
      category: adapter.category,
      externalApi: adapter.externalApi,
      mode: adapter.direction,
      syntaxKinds: exceptionAdapterSyntaxKinds(adapter.direction),
      relationship: exceptionAdapterRelationship(workspace.name, workspace.packageName, adapter),
      provenance: exceptionAdapterProvenance(workspace.name, adapter),
      reason: adapter.reason,
    }),
  ),
);

function approvedExceptionAdapterCatalogSha256(
  approvals: readonly ApprovedExceptionAdapter[],
): string {
  const hash = createHash("sha256");
  for (const approval of approvals) {
    hash.update(
      JSON.stringify([
        approval.workspace,
        approval.callable.module,
        approval.callable.exportName,
        approval.category,
        approval.externalApi.package,
        approval.externalApi.exportName,
        approval.mode,
        approval.syntaxKinds,
        approval.relationship,
        approval.provenance,
        approval.reason,
      ]),
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

export const APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256 =
  "2abe3fb265a828756bc2038c8dff7277a7c7b43184128d9adbb5cd15b2284a70";

export const architectureManifest = {
  version: 1,
  approvedExceptionAdapters: APPROVED_EXCEPTION_ADAPTER_CATALOG,
  approvedExceptionAdapterCatalogSha256: APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256,
  workspaces: ARCHITECTURE_WORKSPACES,
} satisfies ArchitectureManifest;

function requireNonempty(value: string, description: string): void {
  if (!value.trim()) throw new Error(`Architecture manifest ${description} must be nonempty.`);
}

function requireExactIdentity(identity: SymbolIdentity, description: string): void {
  requireNonempty(identity.module, `${description} module`);
  requireNonempty(identity.exportName, `${description} exportName`);
  if (
    identity.module.includes("*") ||
    identity.exportName.includes("*") ||
    identity.exportName === "<module>"
  ) {
    throw new Error(
      `Architecture manifest ${description} must name an exact symbol: ${identity.module}#${identity.exportName}.`,
    );
  }
}

function requireExactModule(module: string, description: string): void {
  requireNonempty(module, `${description} module`);
  if (module.includes("*")) {
    throw new Error(`Architecture manifest ${description} must name an exact module: ${module}.`);
  }
}

function requireExactExceptionAdapterIdentity(adapter: ExceptionAdapter): void {
  if (adapter.identity.exportName !== "<module>") {
    requireExactIdentity(adapter.identity, "exception adapter");
    return;
  }
  requireExactModule(adapter.identity.module, "module entrypoint exception adapter");
  if (adapter.category !== "compatibility" || adapter.direction !== "signal-host") {
    throw new Error(
      `Architecture manifest module entrypoint exception adapter must signal an exact compatibility host contract: ${adapter.identity.module}.`,
    );
  }
}

function identityKey(identity: SymbolIdentity): string {
  return `${identity.module}#${identity.exportName}`;
}

function approvedExceptionAdapterKey(
  workspace: string,
  identity: SymbolIdentity,
  direction: ExceptionAdapter["direction"],
): string {
  return `${workspace}/${identityKey(identity)}@${direction}`;
}

function exceptionAdapterMatchesApproval(
  adapter: ExceptionAdapter,
  approval: ApprovedExceptionAdapter,
): boolean {
  return (
    identityKey(adapter.identity) === identityKey(approval.callable) &&
    adapter.category === approval.category &&
    adapter.externalApi.package === approval.externalApi.package &&
    adapter.externalApi.exportName === approval.externalApi.exportName &&
    adapter.direction === approval.mode &&
    adapter.reason === approval.reason
  );
}

function requireParameterIndex(value: number, description: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Architecture manifest ${description} must be a nonnegative integer.`);
  }
}

function requireUniqueValues(values: readonly string[], description: string): Set<string> {
  const unique = new Set<string>();
  for (const value of values) {
    requireNonempty(value, description);
    if (unique.has(value)) {
      throw new Error(`Architecture manifest ${description} contains duplicate '${value}'.`);
    }
    unique.add(value);
  }
  return unique;
}

function requiredExactRuleModules(
  workspace: WorkspaceArchitecture,
): ReadonlyMap<ArchitectureRule, ReadonlySet<string>> {
  const modules = new Map<ArchitectureRule, Set<string>>();
  const add = (rule: ArchitectureRule, module: string): void => {
    const registered = modules.get(rule) ?? new Set<string>();
    registered.add(module);
    modules.set(rule, registered);
  };
  for (const { identity } of workspace.openProtocolAdapters) {
    add("architecture/open-protocol-normalization", identity.module);
  }
  for (const { identity } of workspace.eventCodecRegistries) {
    add("architecture/complete-event-codec-registry", identity.module);
  }
  for (const { identity, aliases } of workspace.toolCodecRegistries) {
    for (const registered of [identity, ...aliases]) {
      add("architecture/complete-tool-codec-registry", registered.module);
    }
  }
  for (const { identity } of workspace.resultDecoders) {
    add("architecture/result-decoder-contract", identity.module);
  }
  for (const { module } of workspace.unknownFreeModules) {
    add("architecture/unknown-free-module", module);
  }
  for (const { identity } of workspace.persistedCodecs) {
    add("architecture/persisted-codec-contract", identity.module);
    add("architecture/persisted-codec-fixture-catalog", identity.module);
  }
  for (const { identity } of workspace.persistedStoreConsumers) {
    add("architecture/persisted-codec-contract", identity.module);
  }
  for (const { identity } of workspace.sqliteTransactionAdapters) {
    add("architecture/sqlite-transaction-adapter-contract", identity.module);
    add("architecture/no-result-err-in-sqlite-callback", identity.module);
  }
  for (const { identity } of workspace.sqliteTransactionConsumers) {
    add("architecture/sqlite-transaction-consumer", identity.module);
    add("architecture/no-result-err-in-sqlite-callback", identity.module);
  }
  for (const { identity } of workspace.rawEventMessageBoundaries) {
    add("architecture/raw-event-message-boundary", identity.module);
  }
  for (const { identity, deliveryPolicy } of workspace.eventDeliveryApis) {
    add("architecture/event-handler-result", identity.module);
    add("architecture/event-delivery-policy-exhaustiveness", deliveryPolicy.module);
  }
  return modules;
}

function requiredOperationalResultApis(
  workspace: WorkspaceArchitecture,
): readonly SymbolIdentity[] {
  return [
    ...workspace.resultDecoders.map(({ identity }) => identity),
    ...workspace.persistedCodecs.map(({ identity }) => identity),
    ...workspace.persistedStoreConsumers.map(({ identity }) => identity),
    ...workspace.sqliteTransactionAdapters.map(({ identity }) => identity),
    ...workspace.sqliteTransactionConsumers.map(({ identity }) => identity),
    ...workspace.eventDeliveryApis.map(({ identity }) => identity),
  ];
}

export function assertBlobStorageArchitecturePolicyIntegrity(
  manifest: ArchitectureManifest,
  policy: BlobStorageArchitecturePolicy = BLOB_STORAGE_ARCHITECTURE_POLICY,
): void {
  const storage = manifest.workspaces.find(
    (workspace) => workspace.name === policy.storageWorkspace,
  );
  if (!storage) return;
  if (storage.packageName !== policy.storagePackage) {
    throw new Error(
      `Blob storage workspace ${policy.storageWorkspace} must own package ${policy.storagePackage}.`,
    );
  }
  if (!manifest.workspaces.some((workspace) => workspace.name === policy.coreWorkspace)) {
    throw new Error(
      `Blob storage policy references missing Core workspace ${policy.coreWorkspace}.`,
    );
  }
  for (const registrations of [
    policy.eventSchemaModules,
    policy.adapterFactoryOwners,
    policy.closeOwnerModules,
    policy.materializationModules,
    policy.migrationModules,
  ]) {
    const seen = new Set<string>();
    for (const registration of registrations) {
      requireNonempty(registration.workspace, "blob storage policy workspace");
      requireNonempty(registration.module, "blob storage policy module");
      if (!manifest.workspaces.some((workspace) => workspace.name === registration.workspace)) {
        throw new Error(
          `Blob storage policy module ${registration.workspace}/${registration.module} references an inactive workspace.`,
        );
      }
      const key = `${registration.workspace}\0${registration.module}`;
      if (seen.has(key)) {
        throw new Error(
          `Duplicate blob storage policy module ${registration.workspace}/${registration.module}.`,
        );
      }
      seen.add(key);
    }
  }
  requireUniqueValues(policy.adapterFactoryExports, "blob storage adapter factory exports");
  requireUniqueValues(policy.allowedCoreBlobColumns, "allowed Core SQLite BLOB columns");
  requireNonempty(policy.migrationEntrypoint, "blob storage migration entrypoint");
}

export function assertArchitectureManifestIntegrity(manifest: ArchitectureManifest): void {
  assertBlobStorageArchitecturePolicyIntegrity(manifest);
  const workspacesByName = new Map(
    manifest.workspaces.map((workspace) => [workspace.name, workspace] as const),
  );
  const hasExceptionAdapters = manifest.workspaces.some(
    (workspace) => workspace.exceptionAdapters.length > 0,
  );
  if (
    hasExceptionAdapters &&
    (manifest.approvedExceptionAdapters === undefined ||
      manifest.approvedExceptionAdapterCatalogSha256 === undefined)
  ) {
    throw new Error(
      "Architecture manifests with exception adapters must declare the approved global catalog and its exact digest.",
    );
  }
  if (
    (manifest.approvedExceptionAdapters === undefined) !==
    (manifest.approvedExceptionAdapterCatalogSha256 === undefined)
  ) {
    throw new Error(
      "Architecture manifest approved exception adapters and catalog digest must be declared together.",
    );
  }
  const approvedExceptionAdapters = new Map<string, ApprovedExceptionAdapter>();
  if (manifest.approvedExceptionAdapterCatalogSha256 !== undefined) {
    const actualDigest = approvedExceptionAdapterCatalogSha256(
      manifest.approvedExceptionAdapters ?? [],
    );
    if (
      manifest.approvedExceptionAdapterCatalogSha256 !==
        APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256 ||
      actualDigest !== APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256
    ) {
      throw new Error(
        `Approved global exception adapter catalog digest mismatch: expected ${APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256}, received ${actualDigest}.`,
      );
    }
  }
  for (const approval of manifest.approvedExceptionAdapters ?? []) {
    requireExactIdentity(approval.callable, "approved exception adapter callable");
    requireNonempty(approval.externalApi.package, "approved exception adapter external package");
    requireNonempty(
      approval.externalApi.exportName,
      "approved exception adapter external exportName",
    );
    requireNonempty(approval.reason, "approved exception adapter reason");
    const expectedSyntaxKinds = exceptionAdapterSyntaxKinds(approval.mode);
    if (
      approval.syntaxKinds.length !== expectedSyntaxKinds.length ||
      approval.syntaxKinds.some((kind, index) => kind !== expectedSyntaxKinds[index])
    ) {
      throw new Error(
        `Approved exception adapter ${approvedExceptionAdapterKey(approval.workspace, approval.callable, approval.mode)} has syntax kinds that do not match its mode.`,
      );
    }
    const expectedProvenance = exceptionAdapterProvenance(approval.workspace, {
      identity: approval.callable,
      category: approval.category,
      externalApi: approval.externalApi,
      direction: approval.mode,
      reason: approval.reason,
    });
    if (approval.provenance !== expectedProvenance) {
      throw new Error(
        `Approved exception adapter ${approvedExceptionAdapterKey(approval.workspace, approval.callable, approval.mode)} has mismatched provenance.`,
      );
    }
    const expectedRelationship = exceptionAdapterRelationship(
      approval.workspace,
      workspacesByName.get(approval.workspace)?.packageName ?? "",
      {
        identity: approval.callable,
        category: approval.category,
        externalApi: approval.externalApi,
        direction: approval.mode,
        reason: approval.reason,
      },
    );
    if (approval.relationship !== expectedRelationship) {
      throw new Error(
        `Approved exception adapter ${approvedExceptionAdapterKey(approval.workspace, approval.callable, approval.mode)} has a mismatched external/host relationship.`,
      );
    }
    const key = approvedExceptionAdapterKey(approval.workspace, approval.callable, approval.mode);
    if (approvedExceptionAdapters.has(key)) {
      throw new Error(`Duplicate approved exception adapter: ${key}.`);
    }
    approvedExceptionAdapters.set(key, approval);
  }
  const registeredExceptionAdapters = new Set<string>();
  for (const workspace of manifest.workspaces) {
    const operationalResultApiKeys = new Set(
      workspace.operationalResultApis.map((identity) => identityKey(identity)),
    );
    for (const rule of FINAL_PACKAGE_WIDE_ARCHITECTURE_RULES) {
      const zones = workspace.ruleZones[rule] ?? [];
      if (zones.length !== 1 || zones[0]?.include !== "**") {
        throw new Error(
          `Workspace ${workspace.name} must enforce permanent package-wide rule ${rule} with the single '**' zone.`,
        );
      }
    }
    const requiredModules = requiredExactRuleModules(workspace);
    for (const rule of EXACT_REGISTRATION_ARCHITECTURE_RULES) {
      const actual = new Set((workspace.ruleZones[rule] ?? []).map(({ include }) => include));
      const expected = requiredModules.get(rule) ?? new Set<string>();
      if (actual.size !== expected.size || [...expected].some((module) => !actual.has(module))) {
        throw new Error(
          `Workspace ${workspace.name} exact ${rule} zones must equal registered modules; expected ${[...expected].sort().join(", ") || "none"}; received ${[...actual].sort().join(", ") || "none"}. Remove broad or stale zones and register every exact owner.`,
        );
      }
    }
    for (const identity of requiredOperationalResultApis(workspace)) {
      if (!operationalResultApiKeys.has(identityKey(identity))) {
        throw new Error(
          `Workspace ${workspace.name} registered Result boundary ${identityKey(identity)} must also be listed in operationalResultApis.`,
        );
      }
    }
    const unknownFreeModules = new Map<string, UnknownFreeModuleRegistration>();
    for (const registration of workspace.unknownFreeModules) {
      requireExactModule(registration.module, "unknown-free registration");
      if (unknownFreeModules.has(registration.module)) {
        throw new Error(
          `Duplicate unknown-free module registration in ${workspace.name}: ${registration.module}.`,
        );
      }
      unknownFreeModules.set(registration.module, registration);
      if (
        !(workspace.ruleZones["architecture/unknown-free-module"] ?? []).some(
          (zone) => zone.include === registration.module,
        )
      ) {
        throw new Error(
          `Unknown-free module ${registration.module} in ${workspace.name} is outside its workspace rule zones.`,
        );
      }
    }
    const decoderIdentities = new Set<string>();
    for (const decoder of workspace.boundaryDecoders) {
      requireExactIdentity(decoder.identity, "boundary decoder");
      const key = identityKey(decoder.identity);
      if (decoderIdentities.has(key)) {
        throw new Error(`Duplicate boundary decoder registration in ${workspace.name}: ${key}.`);
      }
      decoderIdentities.add(key);
      if (unknownFreeModules.has(decoder.identity.module)) {
        throw new Error(
          `Unknown-free module ${decoder.identity.module} cannot own boundary decoder ${key}.`,
        );
      }
    }
    const resultDecoderIdentities = new Set<string>();
    for (const decoder of workspace.resultDecoders) {
      requireExactIdentity(decoder.identity, "Result decoder");
      requireParameterIndex(decoder.inputParameter, "Result decoder inputParameter");
      const key = identityKey(decoder.identity);
      if (resultDecoderIdentities.has(key)) {
        throw new Error(`Duplicate Result decoder registration in ${workspace.name}: ${key}.`);
      }
      resultDecoderIdentities.add(key);
      if (unknownFreeModules.has(decoder.identity.module)) {
        throw new Error(
          `Unknown-free module ${decoder.identity.module} cannot own Result decoder ${key}.`,
        );
      }
      if (
        !(workspace.ruleZones["architecture/result-decoder-contract"] ?? []).some(
          (zone) => zone.include === decoder.identity.module,
        )
      ) {
        throw new Error(`Result decoder ${key} is outside its workspace rule zones.`);
      }
    }
    const persistedCodecIdentities = new Set<string>();
    for (const codec of workspace.persistedCodecs) {
      requireExactIdentity(codec.identity, "persisted codec");
      requireExactIdentity(codec.fixtureCatalog, "persisted codec fixture catalog");
      requireParameterIndex(codec.inputParameter, "persisted codec inputParameter");
      const key = identityKey(codec.identity);
      if (persistedCodecIdentities.has(key)) {
        throw new Error(`Duplicate persisted codec registration in ${workspace.name}: ${key}.`);
      }
      persistedCodecIdentities.add(key);
      const provenance = requireUniqueValues(codec.provenance, `persisted codec ${key} provenance`);
      if (!provenance.has("current")) {
        throw new Error(`Persisted codec ${key} must declare 'current' provenance.`);
      }
      const legacyOutcome = codec.legacyOutcome ?? "migrated";
      if (legacyOutcome === "migrated" && !provenance.has("migrated")) {
        throw new Error(
          `Persisted codec ${key} must declare 'migrated' provenance for a migrated legacy outcome.`,
        );
      }
      if (legacyOutcome === "rejected" && provenance.has("migrated")) {
        throw new Error(
          `Persisted codec ${key} cannot declare 'migrated' provenance when legacy values are rejected.`,
        );
      }
      if (codec.missingOutcomes !== undefined) {
        const families = Object.entries(codec.missingOutcomes);
        if (families.length === 0) {
          throw new Error(`Persisted codec ${key} missing-outcome registry must not be empty.`);
        }
        for (const [family, outcome] of families) {
          requireNonempty(family, `persisted codec ${key} missing-outcome family`);
          if (outcome === "missing-defaulted" && !provenance.has("missing-defaulted")) {
            throw new Error(
              `Persisted codec ${key} family ${family} defaults missing data without declaring missing-defaulted provenance.`,
            );
          }
        }
      }
      for (const rule of [
        "architecture/persisted-codec-contract",
        "architecture/persisted-codec-fixture-catalog",
      ] as const) {
        if (
          !(workspace.ruleZones[rule] ?? []).some((zone) => zone.include === codec.identity.module)
        ) {
          throw new Error(`Persisted codec ${key} is outside ${rule} workspace rule zones.`);
        }
      }
      if (!operationalResultApiKeys.has(key)) {
        throw new Error(`Persisted codec ${key} must be linked as an operational Result API.`);
      }
    }
    const persistedConsumerIdentities = new Set<string>();
    for (const consumer of workspace.persistedStoreConsumers) {
      requireExactIdentity(consumer.identity, "persisted store consumer");
      const key = identityKey(consumer.identity);
      if (persistedConsumerIdentities.has(key)) {
        throw new Error(`Duplicate persisted store consumer in ${workspace.name}: ${key}.`);
      }
      persistedConsumerIdentities.add(key);
      if (consumer.codecs.length === 0) {
        throw new Error(`Persisted store consumer ${key} must declare at least one codec.`);
      }
      for (const codec of consumer.codecs) {
        requireExactIdentity(codec, "persisted store consumer codec");
        const targetWorkspace =
          codec.package === undefined
            ? workspace
            : manifest.workspaces.find((candidate) => candidate.packageName === codec.package);
        if (
          !targetWorkspace?.persistedCodecs.some(
            (candidate) => identityKey(candidate.identity) === identityKey(codec),
          )
        ) {
          throw new Error(
            `Persisted store consumer ${key} references unregistered codec ${codec.package ?? workspace.packageName}/${identityKey(codec)}.`,
          );
        }
      }
      if (!operationalResultApiKeys.has(key)) {
        throw new Error(
          `Persisted store consumer ${key} must be linked as an operational Result API.`,
        );
      }
      if (
        !(workspace.ruleZones["architecture/persisted-codec-contract"] ?? []).some(
          (zone) => zone.include === consumer.identity.module,
        )
      ) {
        throw new Error(`Persisted store consumer ${key} is outside its workspace rule zones.`);
      }
    }
    const transactionAdapterIdentities = new Set<string>();
    for (const adapter of workspace.sqliteTransactionAdapters) {
      requireExactIdentity(adapter.identity, "SQLite transaction adapter");
      requireExactIdentity(adapter.rollbackSentinel, "SQLite rollback sentinel");
      requireExactIdentity(adapter.driverErrorClassifier, "SQLite driver error classifier");
      requireNonempty(adapter.panicClassifier.package, "SQLite Panic classifier package");
      requireNonempty(adapter.panicClassifier.exportName, "SQLite Panic classifier exportName");
      requireParameterIndex(adapter.databaseParameter, "SQLite adapter databaseParameter");
      requireParameterIndex(adapter.operationParameter, "SQLite adapter operationParameter");
      if (adapter.databaseParameter === adapter.operationParameter) {
        throw new Error(
          `SQLite transaction adapter ${identityKey(adapter.identity)} must use distinct database and operation parameters.`,
        );
      }
      if (
        adapter.panicClassifier.package !== "better-result" ||
        adapter.panicClassifier.exportName !== "Panic.is"
      ) {
        throw new Error(
          `SQLite transaction adapter ${identityKey(adapter.identity)} must use exact better-result#Panic.is classification.`,
        );
      }
      const key = identityKey(adapter.identity);
      if (transactionAdapterIdentities.has(key)) {
        throw new Error(`Duplicate SQLite transaction adapter in ${workspace.name}: ${key}.`);
      }
      transactionAdapterIdentities.add(key);
      if (
        !(workspace.ruleZones["architecture/sqlite-transaction-adapter-contract"] ?? []).some(
          (zone) => zone.include === adapter.identity.module,
        )
      ) {
        throw new Error(`SQLite transaction adapter ${key} is outside its workspace rule zones.`);
      }
      if (!operationalResultApiKeys.has(key)) {
        throw new Error(
          `SQLite transaction adapter ${key} must be linked as an operational Result API.`,
        );
      }
    }
    const transactionConsumerIdentities = new Set<string>();
    for (const consumer of workspace.sqliteTransactionConsumers) {
      requireExactIdentity(consumer.identity, "SQLite transaction consumer");
      requireExactIdentity(consumer.adapter, "SQLite transaction consumer adapter");
      const key = identityKey(consumer.identity);
      if (transactionConsumerIdentities.has(key)) {
        throw new Error(`Duplicate SQLite transaction consumer in ${workspace.name}: ${key}.`);
      }
      transactionConsumerIdentities.add(key);
      const adapterWorkspace =
        consumer.adapter.package === undefined
          ? workspace
          : manifest.workspaces.find(
              (candidate) => candidate.packageName === consumer.adapter.package,
            );
      if (
        !adapterWorkspace?.sqliteTransactionAdapters.some(
          (candidate) => identityKey(candidate.identity) === identityKey(consumer.adapter),
        )
      ) {
        throw new Error(
          `SQLite transaction consumer ${key} references unregistered adapter ${consumer.adapter.package ?? workspace.packageName}/${identityKey(consumer.adapter)}.`,
        );
      }
      if (!operationalResultApiKeys.has(key)) {
        throw new Error(
          `SQLite transaction consumer ${key} must be linked as an operational Result API.`,
        );
      }
      if (
        !(workspace.ruleZones["architecture/sqlite-transaction-consumer"] ?? []).some(
          (zone) => zone.include === consumer.identity.module,
        )
      ) {
        throw new Error(`SQLite transaction consumer ${key} is outside its workspace rule zones.`);
      }
    }
    for (const exception of [...workspace.opaqueUnknown, ...workspace.capabilityPredicates]) {
      requireExactIdentity(exception.identity, "reasoned symbol registration");
      requireNonempty(exception.reason, "reasoned symbol registration reason");
    }
    for (const adapter of workspace.exceptionAdapters) {
      requireExactExceptionAdapterIdentity(adapter);
      requireNonempty(adapter.externalApi.package, "exception adapter external package");
      requireNonempty(adapter.externalApi.exportName, "exception adapter external exportName");
      requireNonempty(adapter.reason, "exception adapter reason");
      const key = approvedExceptionAdapterKey(workspace.name, adapter.identity, adapter.direction);
      const approval = approvedExceptionAdapters.get(key);
      if (!approval || !exceptionAdapterMatchesApproval(adapter, approval)) {
        throw new Error(
          `Exception adapter ${key} is not an exact member of the approved global catalog.`,
        );
      }
      if (registeredExceptionAdapters.has(key)) {
        throw new Error(`Duplicate exception adapter registration: ${key}.`);
      }
      registeredExceptionAdapters.add(key);
    }
    for (const api of workspace.operationalResultApis) {
      requireExactIdentity(api, "operational Result API");
    }
    const codecRegistries = new Set<string>();
    for (const registry of workspace.eventCodecRegistries) {
      requireExactIdentity(registry.identity, "event codec registry");
      requireExactIdentity(registry.catalog, "canonical event catalog");
      requireExactIdentity(registry.catalogHelper, "event catalog helper");
      requireExactIdentity(registry.registryHelper, "event codec registry helper");
      const key = identityKey(registry.identity);
      if (unknownFreeModules.has(registry.identity.module)) {
        throw new Error(
          `Unknown-free module ${registry.identity.module} cannot own event codec registry ${key}.`,
        );
      }
      if (codecRegistries.has(key)) {
        throw new Error(
          `Duplicate event codec registry registration in ${workspace.name}: ${key}.`,
        );
      }
      codecRegistries.add(key);
    }
    const toolCodecRegistries = new Set<string>();
    for (const registry of workspace.toolCodecRegistries) {
      requireExactIdentity(registry.identity, "tool codec registry");
      requireExactIdentity(registry.canonicalTools, "canonical tool catalog");
      if (
        registry.canonicalTools.package !== undefined &&
        !manifest.workspaces.some(
          (candidate) => candidate.packageName === registry.canonicalTools.package,
        )
      ) {
        throw new Error(
          `Canonical tool catalog package ${registry.canonicalTools.package} is not an active workspace package.`,
        );
      }
      const key = identityKey(registry.identity);
      if (unknownFreeModules.has(registry.identity.module)) {
        throw new Error(
          `Unknown-free module ${registry.identity.module} cannot own tool codec registry ${key}.`,
        );
      }
      if (toolCodecRegistries.has(key)) {
        throw new Error(`Duplicate tool codec registry registration in ${workspace.name}: ${key}.`);
      }
      toolCodecRegistries.add(key);
      const aliases = new Set<string>();
      for (const alias of registry.aliases) {
        requireExactIdentity(alias, "tool codec registry alias");
        const aliasKey = identityKey(alias);
        if (aliasKey === key || aliases.has(aliasKey)) {
          throw new Error(
            `Duplicate tool codec registry value registration in ${workspace.name}: ${aliasKey}.`,
          );
        }
        aliases.add(aliasKey);
        if (unknownFreeModules.has(alias.module)) {
          throw new Error(
            `Unknown-free module ${alias.module} cannot own tool codec registry alias ${aliasKey}.`,
          );
        }
      }
      if (
        !(workspace.ruleZones["architecture/complete-tool-codec-registry"] ?? []).some(
          (zone) => zone.include === registry.identity.module,
        )
      ) {
        throw new Error(`Tool codec registry ${key} is outside its workspace rule zones.`);
      }
    }
    const rawBoundaryIdentities = new Set<string>();
    for (const boundary of workspace.rawEventMessageBoundaries) {
      requireExactIdentity(boundary.identity, "raw event message boundary");
      requireNonempty(boundary.messageType.package, "raw event message type package");
      requireNonempty(boundary.messageType.exportName, "raw event message type exportName");
      requireParameterIndex(boundary.handlerParameter, "raw event handlerParameter");
      requireParameterIndex(boundary.messageParameter, "raw event messageParameter");
      requireParameterIndex(boundary.contextParameter, "raw event contextParameter");
      if (boundary.messageParameter === boundary.contextParameter) {
        throw new Error(
          `Architecture manifest raw event boundary ${identityKey(boundary.identity)} must use distinct message and context parameters.`,
        );
      }
      const key = identityKey(boundary.identity);
      if (rawBoundaryIdentities.has(key)) {
        throw new Error(`Duplicate raw event message boundary in ${workspace.name}: ${key}.`);
      }
      rawBoundaryIdentities.add(key);
    }
    const deliveryApiIdentities = new Set<string>();
    for (const api of workspace.eventDeliveryApis) {
      requireExactIdentity(api.identity, "event delivery API");
      requireExactIdentity(api.deliveryPolicy, "event delivery policy");
      requireParameterIndex(api.handlerParameter, "event delivery handlerParameter");
      requireParameterIndex(api.handlerMessageParameter, "event delivery handlerMessageParameter");
      requireParameterIndex(api.handlerContextParameter, "event delivery handlerContextParameter");
      requireParameterIndex(api.deliveryErrorParameter, "event delivery deliveryErrorParameter");
      if (api.handlerMessageParameter === api.handlerContextParameter) {
        throw new Error(
          `Architecture manifest event delivery API ${identityKey(api.identity)} must use distinct handler message and context parameters.`,
        );
      }
      const key = identityKey(api.identity);
      if (deliveryApiIdentities.has(key)) {
        throw new Error(`Duplicate event delivery API registration in ${workspace.name}: ${key}.`);
      }
      deliveryApiIdentities.add(key);
    }
    const deliveryConsumerIdentities = new Set<string>();
    for (const consumer of workspace.eventDeliveryConsumers) {
      requireExactIdentity(consumer.identity, "event delivery consumer");
      requireNonempty(consumer.apiPackage, "event delivery consumer apiPackage");
      const key = identityKey(consumer.identity);
      if (deliveryConsumerIdentities.has(key)) {
        throw new Error(
          `Duplicate event delivery consumer registration in ${workspace.name}: ${key}.`,
        );
      }
      deliveryConsumerIdentities.add(key);
      const operations = requireUniqueValues(
        consumer.operations,
        `event delivery consumer ${key} operations`,
      );
      if (operations.size === 0) {
        throw new Error(
          `Architecture manifest event delivery consumer ${key} must declare operations.`,
        );
      }
    }
    const openProtocolZones = workspace.ruleZones["architecture/open-protocol-normalization"] ?? [];
    for (const zone of openProtocolZones) {
      requireNonempty(zone.include, "open-protocol rule zone");
      if (zone.include.includes("*")) {
        throw new Error(
          `Architecture manifest open-protocol rule zone in ${workspace.name} must name an exact module: ${zone.include}.`,
        );
      }
    }
    const identities = new Set<string>();
    for (const adapter of workspace.openProtocolAdapters) {
      requireNonempty(adapter.identity.module, "open-protocol adapter module");
      requireNonempty(adapter.identity.exportName, "open-protocol adapter exportName");
      requireNonempty(adapter.externalProtocol.package, "open-protocol package");
      requireNonempty(adapter.externalProtocol.exportName, "open-protocol exportName");
      requireNonempty(adapter.fallbackVariant.discriminant, "open-protocol fallback discriminant");
      requireNonempty(adapter.fallbackVariant.value, "open-protocol fallback value");
      requireNonempty(adapter.reason, "open-protocol adapter reason");
      if (!Number.isInteger(adapter.protocolParameter) || adapter.protocolParameter < 0) {
        throw new Error(
          `Architecture manifest open-protocol adapter ${adapter.identity.module}#${adapter.identity.exportName} has an invalid protocolParameter.`,
        );
      }
      if (!openProtocolZones.some((zone) => zone.include === adapter.identity.module)) {
        throw new Error(
          `Architecture manifest open-protocol adapter ${adapter.identity.module}#${adapter.identity.exportName} is outside its workspace rule zones.`,
        );
      }
      const identity = `${adapter.identity.module}#${adapter.identity.exportName}`;
      if (identities.has(identity)) {
        throw new Error(
          `Duplicate open-protocol adapter registration in ${workspace.name}: ${identity}.`,
        );
      }
      identities.add(identity);
    }
  }
  for (const key of approvedExceptionAdapters.keys()) {
    if (!registeredExceptionAdapters.has(key)) {
      throw new Error(
        `Approved global exception adapter ${key} is not registered by its workspace.`,
      );
    }
  }
}
