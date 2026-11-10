import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import {
  BLOB_STORAGE_ARCHITECTURE_POLICY,
  architectureManifest,
  type ArchitectureManifest,
  type BlobStorageArchitecturePolicy,
  type ExceptionAdapter,
} from "../architecture/manifest.ts";
import {
  findBlobStorageSeamViolations,
  findExceptionFlowViolations,
  findExceptionFlowViolationsInSourceFile,
  findDirectSqliteTransactionViolations,
  findDirectSqliteTransactionViolationsInSourceFile,
  findElseAfterTerminalViolations,
  findElseAfterTerminalViolationsInSourceFile,
  findInlineAsyncResultCallbackViolations,
  findInlineAsyncResultCallbackViolationsInSourceFile,
  findLocalRecordGuardViolations,
  findPresentationDecoderImportViolations,
  findPresentationDecoderImportViolationsInSourceFile,
  findPreferSwitchTrueChainViolations,
  findPreferSwitchTrueChainViolationsInSourceFile,
  findStoreInlineDecodingViolations,
  findStoreInlineDecodingViolationsInSourceFile,
  parseProductionSyntaxSource,
} from "./production-syntax.mts";
import { type SyntacticPolicy, SYNTACTIC_POLICY } from "./syntax-policy.mts";

type FixtureArchitectureManifest = ArchitectureManifest & {
  readonly approvedExceptionAdapters: readonly [];
  readonly approvedExceptionAdapterCatalogSha256: string;
};

function policyWith(overrides: Partial<SyntacticPolicy> = {}): SyntacticPolicy {
  return { ...SYNTACTIC_POLICY, ...overrides };
}

function manifestWithUnknownFreeModule(): FixtureArchitectureManifest {
  const manifest = manifestWithAdapters([]);
  const workspace = manifest.workspaces[0];
  if (!workspace) throw new Error("fixture workspace missing");
  return {
    ...manifest,
    workspaces: [
      {
        ...workspace,
        unknownFreeModules: [{ module: "src/render.ts" }],
      },
    ],
  };
}

function manifestWithPresentationBoundaries(): FixtureArchitectureManifest {
  const manifest = manifestWithUnknownFreeModule();
  const workspace = manifest.workspaces[0];
  if (!workspace) throw new Error("fixture workspace missing");
  return {
    ...manifest,
    workspaces: [
      {
        ...workspace,
        boundaryDecoders: [
          {
            identity: { module: "src/projection.ts", exportName: "projectToolObservation" },
            category: "projection",
          },
        ],
        resultDecoders: [
          {
            identity: { module: "src/projection.ts", exportName: "decodeKnownObservation" },
            category: "projection",
            inputParameter: 0,
          },
        ],
        openProtocolAdapters: [
          {
            identity: { module: "src/projection.ts", exportName: "projectOpenChunk" },
            externalProtocol: { package: "open-sdk", exportName: "Chunk" },
            protocolParameter: 0,
            fallbackVariant: { discriminant: "kind", value: "unsupported" },
            reason: "Synthetic presentation projection boundary.",
          },
        ],
        toolCodecRegistries: [
          {
            identity: {
              module: "src/projection.ts",
              exportName: "toolObservationCodecRegistry",
            },
            aliases: [{ module: "src/projection.ts", exportName: "knownToolCodecRegistry" }],
            canonicalTools: {
              module: "src/protocol.ts",
              exportName: "TOOL_NAMES",
            },
          },
        ],
      },
    ],
  };
}

function manifestWithAdapters(adapters: readonly ExceptionAdapter[]): FixtureArchitectureManifest {
  return {
    version: 1,
    approvedExceptionAdapters: [],
    approvedExceptionAdapterCatalogSha256: "fixture-catalog-digest",
    workspaces: [
      {
        name: "apps/example",
        packageName: "@example/app",
        root: "apps/example",
        tsconfig: "apps/example/tsconfig.json",
        ruleZones: {},
        boundaryDecoders: [],
        opaqueUnknown: [],
        capabilityPredicates: [],
        exceptionAdapters: adapters,
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
      },
    ],
  };
}

function manifestWithStage6(): FixtureArchitectureManifest {
  const manifest = manifestWithAdapters([]);
  const workspace = manifest.workspaces[0];
  if (!workspace) throw new Error("fixture workspace missing");
  return {
    ...manifest,
    workspaces: [
      {
        ...workspace,
        persistedCodecs: [
          {
            identity: { module: "src/codecs.ts", exportName: "decodeStoredValue" },
            inputParameter: 0,
            fixtureCatalog: { module: "tests/codecs.test.ts", exportName: "storedValueCases" },
            provenance: ["current", "migrated", "missing-defaulted"],
          },
        ],
        persistedStoreConsumers: [
          {
            identity: { module: "src/store.ts", exportName: "Store.load" },
            codecs: [{ module: "src/codecs.ts", exportName: "decodeStoredValue" }],
          },
        ],
        sqliteTransactionAdapters: [
          {
            identity: { module: "src/sqlite-adapter.ts", exportName: "runTransaction" },
            databaseParameter: 0,
            operationParameter: 1,
            rollbackSentinel: { module: "src/sqlite-adapter.ts", exportName: "Rollback" },
            panicClassifier: { package: "better-result", exportName: "Panic.is" },
            driverErrorClassifier: {
              module: "src/sqlite-adapter.ts",
              exportName: "classifyDriverError",
            },
          },
        ],
        sqliteTransactionConsumers: [
          {
            identity: { module: "src/store.ts", exportName: "Store.save" },
            adapter: { module: "src/sqlite-adapter.ts", exportName: "runTransaction" },
          },
        ],
      },
    ],
  };
}

function adapter(exportName: string, direction: ExceptionAdapter["direction"]): ExceptionAdapter {
  return {
    identity: { module: "src/adapter.ts", exportName },
    category: direction === "signal-host" ? "result-to-framework" : "defect-supervisor",
    externalApi: { package: "example-host", exportName: "operation" },
    direction,
    reason: "Test exact adapter registration",
  };
}

describe("parsed production syntax finders", () => {
  it("keeps all active SourceFile finders equivalent to the text wrappers", () => {
    const exceptionSource = `export function fail() { throw new Error("bad"); }`;
    const exceptionPath = "apps/example/src/service.ts";
    expect(
      findExceptionFlowViolationsInSourceFile(
        parseProductionSyntaxSource(exceptionSource, exceptionPath),
        exceptionPath,
      ),
    ).toEqual(findExceptionFlowViolations(exceptionSource, exceptionPath));

    const resultSource = `
      import { Result } from "better-result";
      Result.map(async (value) => value);
    `;
    const resultPath = "apps/example/src/result-flow.ts";
    expect(
      findInlineAsyncResultCallbackViolationsInSourceFile(
        parseProductionSyntaxSource(resultSource, resultPath),
        resultPath,
      ),
    ).toEqual(findInlineAsyncResultCallbackViolations(resultSource, resultPath));

    const controlFlowSource = `
      function classify() {
        if (a || b) return 1;
        else if (c || d) return 2;
        else if (e) return 3;
      }
    `;
    const controlFlowPath = "apps/example/src/control-flow.ts";
    const controlFlowSourceFile = parseProductionSyntaxSource(controlFlowSource, controlFlowPath);
    expect(
      findPreferSwitchTrueChainViolationsInSourceFile(controlFlowSourceFile, controlFlowPath),
    ).toEqual(findPreferSwitchTrueChainViolations(controlFlowSource, controlFlowPath));
    expect(
      findElseAfterTerminalViolationsInSourceFile(controlFlowSourceFile, controlFlowPath),
    ).toEqual(findElseAfterTerminalViolations(controlFlowSource, controlFlowPath));

    const presentationSource = `import { z } from "zod"; z.string().parse("value");`;
    const presentationPath = "apps/example/src/render.ts";
    const presentationManifest = manifestWithUnknownFreeModule();
    expect(
      findPresentationDecoderImportViolationsInSourceFile(
        parseProductionSyntaxSource(presentationSource, presentationPath),
        presentationPath,
        presentationManifest,
      ),
    ).toEqual(
      findPresentationDecoderImportViolations(
        presentationSource,
        presentationPath,
        policyWith(),
        presentationManifest,
      ),
    );

    const storeSource = `class Store { load(raw: string) { return JSON.parse(raw); } }`;
    const storePath = "apps/example/src/store.ts";
    const storeManifest = manifestWithStage6();
    expect(
      findStoreInlineDecodingViolationsInSourceFile(
        parseProductionSyntaxSource(storeSource, storePath),
        storePath,
        storeManifest,
      ),
    ).toEqual(
      findStoreInlineDecodingViolations(storeSource, storePath, policyWith(), storeManifest),
    );

    const sqliteSource = `class Store { save() { this.db.exec("BEGIN"); } }`;
    expect(
      findDirectSqliteTransactionViolationsInSourceFile(
        parseProductionSyntaxSource(sqliteSource, storePath),
        storePath,
        storeManifest,
      ),
    ).toEqual(
      findDirectSqliteTransactionViolations(sqliteSource, storePath, policyWith(), storeManifest),
    );
  });
});

describe("flat control flow syntax", () => {
  const filePath = "apps/example/src/control-flow.ts";

  it("prefers switch true for ordered chains with multiple disjunctive arms", () => {
    const violations = findPreferSwitchTrueChainViolations(
      `
        if (a || b || c) first();
        else if (d || e) second();
        else if (f) third();
        else fallback();

        if (a || b) first();
        else fallback();

        if (a || b) first();
        else if (c) second();
        else if (d) fallback();

        if (a || b) first();
        else if (c || d) second();
        else if (e) third();
      `,
      filePath,
      policyWith(),
    );

    expect(violations.map(({ kind }) => kind)).toEqual([
      "prefer-switch-true-chain",
      "prefer-switch-true-chain",
    ]);
  });

  it("removes else branches after direct terminal statements", () => {
    const violations = findElseAfterTerminalViolations(
      `
        function returned() {
          if (ready) return value;
          else return fallback;
        }
        function thrown() {
          if (failed) { throw error; }
          else recover();
        }
        function loop() {
          while (active) {
            if (skip) { continue; }
            else visit();
            if (done) break;
            else advance();
          }
        }
        function retainedElse() {
          if (ready) prepare();
          else fallback();
        }
      `,
      filePath,
      policyWith(),
    );

    expect(violations.map(({ kind }) => kind)).toEqual([
      "else-after-terminal",
      "else-after-terminal",
      "else-after-terminal",
      "else-after-terminal",
    ]);
  });

  it("excludes test modules from production control-flow rules", () => {
    const source = `
      if (a || b) first();
      else if (c || d) second();
      else if (e) fallback();
      if (ready) returnValue();
      else fallback();
    `;
    expect(
      findPreferSwitchTrueChainViolations(source, "apps/example/tests/control-flow.test.ts"),
    ).toEqual([]);
    expect(
      findElseAfterTerminalViolations(source, "apps/example/tests/control-flow.test.ts"),
    ).toEqual([]);
  });
});

describe("unified blob-storage seam syntax", () => {
  const findings = (
    source: string,
    filePath: string,
    policy: BlobStorageArchitecturePolicy = BLOB_STORAGE_ARCHITECTURE_POLICY,
  ) => findBlobStorageSeamViolations(source, filePath, policyWith(), architectureManifest, policy);

  it("keeps Bun S3 operations and Lilac domain dependencies inside the storage package", () => {
    expect(
      findings('import { S3Client } from "bun"; new S3Client({});', "apps/core/src/s3.ts").map(
        ({ kind }) => kind,
      ),
    ).toEqual(["s3-storage-import", "s3-storage-import"]);
    expect(
      findings(
        'import { RedisStreamsBus } from "@stanley2058/lilac-event-bus";',
        "packages/blob-storage/src/adapter.ts",
      ).map(({ kind }) => kind),
    ).toEqual(["blob-domain-import"]);
    expect(
      findings(
        'import { secret } from "../../../apps/core/src/runtime/private";',
        "packages/blob-storage/src/adapter.ts",
      ).map(({ kind }) => kind),
    ).toEqual(["blob-domain-import"]);
    expect(
      findings(
        'import { S3Client } from "bun"; new S3Client({});',
        "packages/blob-storage/src/s3.ts",
      ),
    ).toEqual([]);
  });

  it("allows adapter construction only at composition and rejects current inline wire bytes", () => {
    const factoryImport = 'import { createLocalBlobStore } from "@stanley2058/lilac-blob-storage";';
    expect(
      findings(factoryImport, "apps/core/src/surface/leaf.ts").map(({ kind }) => kind),
    ).toEqual(["adapter-construction-import"]);
    expect(findings(factoryImport, "apps/core/src/runtime/create-core-blob-store.ts")).toEqual([]);
    expect(
      findings(
        'import * as blobs from "@stanley2058/lilac-blob-storage"; blobs.createLocalBlobStore({});',
        "apps/core/src/surface/leaf.ts",
      ).map(({ kind }) => kind),
    ).toEqual(["adapter-construction-import"]);
    expect(
      findings(
        "const binarySchema = z.strictObject({ dataBase64: z.string() });",
        "packages/event-bus/lilac-spec.ts",
      ).map(({ kind }) => kind),
    ).toEqual(["current-inline-blob-value"]);
  });

  it("rejects managed SQLite BLOB columns but keeps structured embeddings", () => {
    expect(
      findings(
        "db.exec(`CREATE TABLE artifacts (payload BLOB NOT NULL, embedding BLOB NOT NULL)`);",
        "apps/core/src/workflow/store.ts",
      ).map(({ kind, message }) => ({ kind, message })),
    ).toEqual([
      {
        kind: "core-inline-blob-column",
        message: expect.stringContaining("payload"),
      },
    ]);
  });

  it("localizes BlobStore open and close ownership and legacy decoder imports", () => {
    const blobCalls = `
      import type { BlobStore } from "@stanley2058/lilac-blob-storage";
      export async function leaf(blobStore: BlobStore) {
        await blobStore.open(ref);
        await blobStore.close({ deadlineAtMs: Date.now() });
      }
    `;
    expect(findings(blobCalls, "apps/core/src/surface/leaf.ts").map(({ kind }) => kind)).toEqual([
      "blob-materialization-locality",
      "blob-store-close-ownership",
    ]);
    const materializationPolicy = {
      ...BLOB_STORAGE_ARCHITECTURE_POLICY,
      materializationModules: [{ workspace: "apps/core", module: "src/surface/blob-materializer" }],
    } satisfies BlobStorageArchitecturePolicy;
    expect(
      findings(
        blobCalls.replace("await blobStore.close({ deadlineAtMs: Date.now() });", ""),
        "apps/core/src/surface/blob-materializer.ts",
        materializationPolicy,
      ),
    ).toEqual([]);

    const legacyImport = 'import { decodeLegacyBlobRow } from "./legacy-blob-codec";';
    expect(findings(legacyImport, "apps/core/src/runtime/main.ts").map(({ kind }) => kind)).toEqual(
      ["legacy-blob-decoder-import"],
    );
    expect(
      findings(legacyImport, "apps/core/scripts/migrate-blob-storage.ts").map(({ kind }) => kind),
    ).toEqual(["legacy-blob-decoder-import"]);
  });
});

describe("production exception syntax", () => {
  it("detects only syntactically proven Promise rejection channels and aliases", () => {
    const violations = findExceptionFlowViolations(
      `
        const P = globalThis.Promise;
        const rejectPromise = P.reject;
        const direct = Promise.resolve(1);
        let assigned;
        assigned = P.resolve(2);
        async function load() { return 1; }
        Promise.reject(error);
        globalThis.Promise.reject(error);
        rejectPromise(error);
        direct.catch(handleRejected);
        assigned.then(useValue, handleRejected);
        load().then(useValue, handleRejected);
        new P((resolve, reject) => reject(error));
        new Promise((resolve, reject) => { const fail = reject; fail(error); });
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "promise-reject",
      "promise-reject",
      "promise-reject",
      "promise-catch",
      "rejection-callback",
      "rejection-callback",
      "rejection-callback",
      "rejection-callback",
    ]);
  });

  it("detects global fetch, promise-only standard imports, local async calls, and wrapped reject", () => {
    const violations = findExceptionFlowViolations(
      `
        import fsp from "node:fs/promises";
        import { readFile as read } from "fs/promises";
        import * as dns from "node:dns/promises";
        import { pipeline } from "stream/promises";
        import { setTimeout as delay } from "node:timers/promises";
        beforeDeclaration().catch(handleRejected);
        async function beforeDeclaration() { return 1; }
        const local = (async () => 2);
        fetch(url).catch(handleRejected);
        globalThis.fetch(url).then(useValue, handleRejected);
        fsp.readFile(path).catch(handleRejected);
        read(path).catch(handleRejected);
        dns.lookup(host).catch(handleRejected);
        pipeline(source, destination).catch(handleRejected);
        delay(1).catch(handleRejected);
        (local)().catch(handleRejected);
        (Promise.reject)(error);
        (Promise.reject as typeof Promise.reject)(error);
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "promise-catch",
      "promise-catch",
      "rejection-callback",
      "promise-catch",
      "promise-catch",
      "promise-catch",
      "promise-catch",
      "promise-catch",
      "promise-catch",
      "promise-reject",
      "promise-reject",
    ]);
  });

  it("treats every catch method and non-nullish then rejection callback as exception flow", () => {
    const violations = findExceptionFlowViolations(
      `
        cache.catch(handleMiss);
        query.then(useValue, handleRejected);
        query.then(useValue, null);
        Promise.resolve(1).then(useValue, null);
        Promise.resolve(1).then(useValue, undefined);
        new Promise((resolve, reject) => resolve(1));
        logger.error("reported");
        controller.error(error);
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "promise-catch",
      "rejection-callback",
    ]);
  });

  it("detects spread arguments that can occupy the then rejection callback slot", () => {
    const violations = findExceptionFlowViolations(
      `
        task.then(...callbacks);
        task.then(useValue, ...rejectionCallbacks);
        task.then(useValue);
        task.then(useValue, null, ...laterCallbacks);
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "rejection-callback",
      "rejection-callback",
    ]);
  });

  it("does not require Promise provenance for catch methods", () => {
    const violations = findExceptionFlowViolations(
      `
        import { readFile } from "node:fs";
        import { createInterface } from "node:readline/promises";
        function local() { return cache; }
        function withFetch(fetch: () => { catch(handler: unknown): void }) {
          fetch().catch(handleRejected);
        }
        client.fetch(url).catch(handleRejected);
        readFile(path, callback).catch(handleRejected);
        createInterface(options).catch(handleRejected);
        local().catch(handleRejected);
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "promise-catch",
      "promise-catch",
      "promise-catch",
      "promise-catch",
      "promise-catch",
    ]);
  });

  it("detects throws, catches, and explicit host stream/error signals", () => {
    const violations = findExceptionFlowViolations(
      `
        function run() { try { throw new Error("bad"); } catch (error) { return error; } }
        new ReadableStream({ start(controller) { controller.error(error); } });
        emitter.emit("error", error);
        socket.destroy(error);
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "try-statement",
      "throw",
      "stream-error-signal",
      "stream-error-signal",
      "stream-error-signal",
    ]);
  });

  it("exempts only throws inside object captures proven from better-result imports", () => {
    const violations = findExceptionFlowViolations(
      `
        import { Result as R } from "better-result";
        import * as Better from "better-result";
        const Alias = R;
        const capture = Alias.try;
        const FakeResult = { try: (options) => options.try() };
        export function run() {
          const captured = capture({ try: () => { throw new Error("captured"); }, catch: String });
          Better.Result.try({ try: () => { throw new Error("namespace captured"); }, catch: String });
          FakeResult.try({ try: () => { throw new Error("fake"); }, catch: String });
          if (captured) throw new Error("same callable");
        }
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map(({ kind, symbol }) => [kind, symbol])).toEqual([
      ["throw", "run.try@3"],
      ["throw", "run"],
    ]);
  });

  it("does not trust mutated better-result bindings or aliases", () => {
    const violations = findExceptionFlowViolations(
      `
        import { Result } from "better-result";
        const Alias = Result;
        Alias.try = fakeCapture;
        Alias.try({ try: () => { throw new Error("mutated alias"); }, catch: String });
        Result.try = fakeCapture;
        Result.try({ try: () => { throw new Error("mutated root"); }, catch: String });
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map(({ kind }) => kind)).toEqual(["throw", "throw"]);
  });

  it("does not trust better-result aliases mutated through reflective object operations", () => {
    const violations = findExceptionFlowViolations(
      `
        import { Result } from "better-result";
        const Assigned = Result;
        Object.assign(Assigned, { try: fakeCapture });
        Assigned.try({ try: () => { throw new Error("assigned"); }, catch: String });
        const Reflected = Result;
        Reflect.set(Reflected, "try", fakeCapture);
        Reflected.try({ try: () => { throw new Error("reflected"); }, catch: String });
        const Defined = Result;
        Object.defineProperty(Defined, "try", { value: fakeCapture });
        const capture = Defined.try;
        capture({ try: () => { throw new Error("defined"); }, catch: String });
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map(({ kind }) => kind)).toEqual(["throw", "throw", "throw"]);
  });

  it("owns Stage 1 TaggedError throws, broad catches, and rejected Result promises", () => {
    const violations = findExceptionFlowViolations(
      `
        import { TaggedError, type Result } from "better-result";
        class Failure extends TaggedError("Failure") {}
        export function throwsTaggedError(): Result<string, Failure> {
          throw new Failure();
        }
        export function broadCatch(): Result<string, Failure> {
          try { return operation(); } catch (cause) { return mapCause(cause); }
        }
        export function rejectsResultPromise(): Promise<Result<string, Failure>> {
          return Promise.reject(new Failure());
        }
      `,
      "apps/example/src/stage1.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "throw",
      "try-statement",
      "promise-reject",
    ]);
    expect(violations.map((violation) => violation.message)).toEqual([
      "Return a typed Result error; throw only in an exactly registered adapter",
      "Use object-form Result.try or Result.tryPromise; production try statements are forbidden",
      "Return Result.err instead of Promise.reject",
    ]);
  });

  it("uses exact adapter identities and permissions from the shared architecture manifest", () => {
    const code = `
      export function captureExternal() { try { return operation(); } catch (error) { throw error; } }
      export function signalHost() { throw new Error("host"); }
      export function domainFlow() { throw new Error("domain"); }
    `;
    const manifest = manifestWithAdapters([
      adapter("captureExternal", "signal-host"),
      adapter("signalHost", "signal-host"),
    ]);

    expect(
      findExceptionFlowViolations(code, "apps/example/src/adapter.ts", policyWith(), manifest).map(
        (violation) => [violation.symbol, violation.kind],
      ),
    ).toEqual([
      ["captureExternal", "try-statement"],
      ["domainFlow", "throw"],
    ]);
  });

  it("allows exact observe-panic throws but never exempts a try statement", () => {
    const code = `
      export function observePanic() {
        try { return operation(); } catch (cause) {
          if (Panic.is(cause)) throw cause;
          return fallback(cause);
        }
      }
      export function observeRejectedPanic() {
        return Promise.resolve().catch((cause) => {
          if (Panic.is(cause)) throw cause;
          return fallback(cause);
        });
      }
    `;
    const manifest = manifestWithAdapters([
      adapter("observePanic", "observe-panic"),
      adapter("observeRejectedPanic.catch.<callback@1>", "observe-panic"),
    ]);

    expect(
      findExceptionFlowViolations(code, "apps/example/src/adapter.ts", policyWith(), manifest).map(
        ({ symbol, kind }) => [symbol, kind],
      ),
    ).toEqual([["observePanic", "try-statement"]]);
  });

  it("does not let observe-panic authorize signaling forms or sibling callables", () => {
    const code = `
      export function observePanic() { return Promise.reject(error); }
      export function sibling() {
        try { return operation(); } catch (cause) { throw cause; }
      }
      export function signalStream() {
        return new ReadableStream({ start(controller) { controller.error(error); } });
      }
    `;
    const manifest = manifestWithAdapters([
      adapter("observePanic", "observe-panic"),
      adapter("signalStream.start", "observe-panic"),
    ]);

    expect(
      findExceptionFlowViolations(code, "apps/example/src/adapter.ts", policyWith(), manifest).map(
        ({ symbol, kind }) => [symbol, kind],
      ),
    ).toEqual([
      ["observePanic", "promise-reject"],
      ["sibling", "try-statement"],
      ["sibling", "throw"],
      ["signalStream.start", "stream-error-signal"],
    ]);
  });

  it("attributes rejection handlers to named and inline callback identities", () => {
    const code = `
      function namedRejection(cause: unknown) { return cause; }
      function outer() {
        void Promise.resolve().then(undefined, namedRejection);
        void Promise.resolve().catch((cause) => cause);
      }
    `;

    expect(
      findExceptionFlowViolations(code, "apps/example/src/adapter.ts", policyWith()).map(
        (violation) => violation.symbol,
      ),
    ).toEqual(["namedRejection", "outer.catch.<callback@1>"]);
    expect(
      findExceptionFlowViolations(
        code,
        "apps/example/src/adapter.ts",
        policyWith(),
        manifestWithAdapters([
          adapter("namedRejection", "signal-host"),
          adapter("outer.catch.<callback@1>", "signal-host"),
        ]),
      ),
    ).toEqual([]);
    expect(
      findExceptionFlowViolations(
        code,
        "apps/example/src/adapter.ts",
        policyWith(),
        manifestWithAdapters([adapter("outer", "signal-host")]),
      ).map((violation) => violation.symbol),
    ).toEqual(["namedRejection", "outer.catch.<callback@1>"]);
  });

  it("disambiguates repeated callback identities instead of allowing one registration to own both", () => {
    const code = `
      function repeated() {
        void Promise.resolve().catch((first) => first);
        void Promise.resolve().catch((second) => second);
      }
    `;
    const identities = findExceptionFlowViolations(
      code,
      "apps/example/src/adapter.ts",
      policyWith(),
    ).map((violation) => violation.symbol);

    expect(identities).toEqual(["repeated.catch.<callback@1>@1", "repeated.catch.<callback@1>@2"]);
    expect(
      findExceptionFlowViolations(
        code,
        "apps/example/src/adapter.ts",
        policyWith(),
        manifestWithAdapters([adapter("repeated.catch.<callback@1>@1", "signal-host")]),
      ).map((violation) => violation.symbol),
    ).toEqual(["repeated.catch.<callback@1>@2"]);
  });

  it("builds exact class and property-arrow symbol paths", () => {
    const violations = findExceptionFlowViolations(
      `
        class Runner {
          capture = () => { throw new Error("capture"); };
          handlers = { fail: () => { throw new Error("handler"); } };
        }
        const Controller = class { fail = () => { throw new Error("class expression"); }; };
        const handlers = { fail: () => { throw new Error("object"); } };
        function outer() { values.map(() => { throw new Error("callback"); }); }
      `,
      "apps/example/src/symbols.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.symbol)).toEqual([
      "Runner.capture",
      "Runner.handlers.fail",
      "Controller.fail",
      "handlers.fail",
      "outer.map.<callback@1>",
    ]);
    expect(violations.every((violation) => violation.digest.length === 64)).toBe(true);
  });

  it("uses exact test/generated exclusions without excluding arbitrary fixture directories", () => {
    const code = `throw new Error("fixture");`;
    expect(
      findExceptionFlowViolations(code, "apps/example/src/fixtures/production.ts", policyWith()),
    ).toHaveLength(1);
    expect(
      findExceptionFlowViolations(code, "apps/example/tests/support.ts", policyWith()),
    ).toEqual([]);
    expect(findExceptionFlowViolations(code, "apps/example/test/support.ts", policyWith())).toEqual(
      [],
    );
    expect(
      findExceptionFlowViolations(code, "apps/example/__tests__/support.ts", policyWith()),
    ).toEqual([]);
    expect(findExceptionFlowViolations(code, "apps/example/dist/output.js", policyWith())).toEqual(
      [],
    );
    expect(
      findExceptionFlowViolations(code, "apps/example/generated/output.js", policyWith()),
    ).toEqual([]);
    expect(
      findExceptionFlowViolations(
        code,
        "apps/core/src/ssh/remote-js/remote-runner.cjs",
        policyWith(),
      ),
    ).toEqual([]);
    expect(
      findExceptionFlowViolations(
        code,
        "apps/core/src/ssh/remote-js/remote-runner-entry.ts",
        policyWith(),
      ),
    ).toHaveLength(1);
  });
});

describe("Stage 5 presentation syntax", () => {
  it("forbids runtime Zod imports in an exact unknown-free module", () => {
    const source = `
      import { z } from "zod";
      import type { ZodType } from "zod";
      export function render(value: string) { return z.string().parse(value); }
    `;
    expect(
      findPresentationDecoderImportViolations(
        source,
        "apps/example/src/render.ts",
        policyWith(),
        manifestWithUnknownFreeModule(),
      ).map((finding) => finding.kind),
    ).toEqual(["presentation-decoder-import"]);
    expect(
      findPresentationDecoderImportViolations(
        source,
        "apps/example/src/other.ts",
        policyWith(),
        manifestWithUnknownFreeModule(),
      ),
    ).toEqual([]);
  });

  it("allows type-only Zod imports in an enforced unknown-free module", () => {
    expect(
      findPresentationDecoderImportViolations(
        'import type { ZodType } from "zod";',
        "apps/example/src/render.ts",
        policyWith(),
        manifestWithUnknownFreeModule(),
      ),
    ).toEqual([]);
  });

  it("forbids registered projection and decoder value imports and calls but allows projection types", () => {
    const findings = findPresentationDecoderImportViolations(
      `
        import {
          type ToolProjection,
          projectToolObservation as project,
          decodeKnownObservation as decode,
          projectOpenChunk,
        } from "./projection";
        import type { AnotherProjection } from "./projection";
        import * as projection from "./projection";

        declare const value: ToolProjection | AnotherProjection;
        project(value);
        decode(value);
        projectOpenChunk(value);
        projection.projectToolObservation(value);
      `,
      "apps/example/src/render.ts",
      policyWith(),
      manifestWithPresentationBoundaries(),
    );

    expect(findings).toHaveLength(8);
    expect(findings.map(({ message }) => message)).toEqual([
      expect.stringContaining("projectToolObservation"),
      expect.stringContaining("decodeKnownObservation"),
      expect.stringContaining("projectOpenChunk"),
      expect.stringContaining("value-import"),
      expect.stringContaining("cannot invoke"),
      expect.stringContaining("cannot invoke"),
      expect.stringContaining("cannot invoke"),
      expect.stringContaining("cannot invoke"),
    ]);
  });

  it("tracks tool codec registries through direct, renamed, namespace, and local aliases", () => {
    const findings = findPresentationDecoderImportViolations(
      `
        import {
          type ToolProjection,
          toolObservationCodecRegistry,
          knownToolCodecRegistry as knownCodecs,
        } from "./projection";
        import * as projection from "./projection";

        declare const raw: ToolProjection;
        toolObservationCodecRegistry.bash.decode(raw);
        const renamedCodecs = knownCodecs;
        const selectedDecoder = renamedCodecs.bash.decode;
        const indirectDecoder = selectedDecoder;
        indirectDecoder(raw);
        projection.knownToolCodecRegistry.bash.decode(raw);
      `,
      "apps/example/src/render.ts",
      policyWith(),
      manifestWithPresentationBoundaries(),
    );

    expect(findings).toHaveLength(6);
    expect(findings.filter(({ message }) => message.includes("value-import"))).toHaveLength(3);
    expect(findings.filter(({ message }) => message.includes("cannot invoke"))).toHaveLength(3);
  });

  it("allows type-only ToolProjection imports from a registered boundary module", () => {
    expect(
      findPresentationDecoderImportViolations(
        'import type { ToolProjection } from "./projection";',
        "apps/example/src/render.ts",
        policyWith(),
        manifestWithPresentationBoundaries(),
      ),
    ).toEqual([]);
  });
});

describe("Result callback syntax", () => {
  it("tracks imports, namespaces, aliases, assignments, and typed Result values", () => {
    const violations = findInlineAsyncResultCallbackViolations(
      `
        import { Result as R, ok as makeOk } from "better-result";
        import * as Better from "better-result";
        R.map(async (value) => value);
        const banana = R.ok(1);
        const copied = banana;
        copied.andThenAsync(async (value) => R.ok(value));
        const made = makeOk(1);
        made.tapAsync(async (value) => observe(value));
        let assigned;
        assigned = Better.Result.err(error);
        assigned.tryRecoverAsync(async () => makeOk(1));
        Better.Result.tapBothAsync({
          ok: async (value) => observe(value),
          err: async (cause) => observe(cause),
        });
        function typed(typedValue: R<number, Error>) {
          return typedValue.tapErrorAsync(async (cause) => observe(cause));
        }
      `,
      "apps/example/src/result-flow.ts",
      policyWith(),
    );

    expect(violations).toHaveLength(7);
  });

  it("does not infer Result provenance from variable names or unrelated methods", () => {
    const violations = findInlineAsyncResultCallbackViolations(
      `
        import { Result as R } from "better-result";
        values.map(async (value) => value);
        userResult.andThenAsync(async (value) => value);
        pipeline.tapAsync(async (value) => value);
        let later;
        later.map(async (value) => value);
        later = R.ok(1);
      `,
      "apps/example/src/result-flow.ts",
      policyWith(),
    );

    expect(violations).toEqual([]);
  });
});

describe("Stage 6 persistence and SQLite syntax", () => {
  it("blocks inline JSON and schema decoding only in exact registered store scopes", () => {
    const source = `
      class Store {
        load(raw: string) {
          const nested = () => JSON.parse(raw);
          const parseJson = JSON.parse;
          const decode = rowSchema.safeParse;
          parseJson(raw);
          decode(raw);
          return rowSchema.safeParse(nested());
        }
        sibling(raw: string) {
          return rowSchema.parse(JSON.parse(raw));
        }
      }
    `;
    const findings = findStoreInlineDecodingViolations(
      source,
      "apps/example/src/store.ts",
      policyWith(),
      manifestWithStage6(),
    );
    expect(findings.map(({ kind, symbol }) => [kind, symbol])).toEqual([
      ["store-inline-json-decoding", "Store.load.nested"],
      ["store-inline-json-decoding", "Store.load"],
      ["store-inline-schema-decoding", "Store.load"],
      ["store-inline-schema-decoding", "Store.load"],
    ]);
  });

  it("blocks direct transaction APIs and manual control in consumers and descendants", () => {
    const findings = findDirectSqliteTransactionViolations(
      `
        class Store {
          save() {
            const begin = "BEGIN IMMEDIATE";
            this.db.run(begin);
            const child = () => this.db.transaction(() => write()).immediate();
            const rawTransaction = this.db.transaction;
            rawTransaction(() => write());
            child();
            this.db.exec("COMMIT");
          }
          sibling() {
            this.db.transaction(() => write()).immediate();
            this.db.run("ROLLBACK");
          }
        }
      `,
      "apps/example/src/store.ts",
      policyWith(),
      manifestWithStage6(),
    );
    expect(findings.map(({ kind, symbol }) => [kind, symbol])).toEqual([
      ["manual-sqlite-transaction-control", "Store.save"],
      ["direct-sqlite-transaction", "Store.save.child"],
      ["direct-sqlite-transaction", "Store.save"],
      ["manual-sqlite-transaction-control", "Store.save"],
    ]);
  });
});

describe("local record guard syntax", () => {
  it("detects canonical record guards regardless of name except the canonical utility", () => {
    const policy = policyWith();
    const code = `
      function asRecord(value: unknown) {
        return typeof value === "object" && value !== null && !Array.isArray(value);
      }
      const objectLike = (candidate: unknown) =>
        !Array.isArray(candidate) && candidate !== null && typeof candidate === "object";
    `;
    expect(findLocalRecordGuardViolations(code, "apps/example/src/guards.ts", policy)).toHaveLength(
      2,
    );
    expect(
      findLocalRecordGuardViolations(
        `export function isRecord(value: unknown) {
          return typeof value === "object" && value !== null && !Array.isArray(value);
        }`,
        "packages/utils/runtime-utils.ts",
        policy,
      ),
    ).toEqual([]);
  });

  it("detects multi-return guards in functions, class fields, and object properties", () => {
    const code = `
      function asRecord(value: unknown): Record<string, unknown> | undefined {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
        return value as Record<string, unknown>;
      }
      class GuardSet {
        asRecord = function (candidate: unknown): Record<string, unknown> | undefined {
          if (typeof candidate !== "object" || candidate === null) return undefined;
          if (Array.isArray(candidate)) return undefined;
          return candidate as Record<string, unknown>;
        };
      }
      const guards = {
        objectRecord: (input: unknown): Record<string, unknown> | undefined => {
          if (Array.isArray(input) || input === null || typeof input !== "object") return undefined;
          return input as Record<string, unknown>;
        },
      };
    `;
    expect(
      findLocalRecordGuardViolations(code, "apps/example/src/multi-return-guards.ts", policyWith()),
    ).toHaveLength(3);
  });

  it("allows complete decoders, capability checks, and wrappers around canonical isRecord", () => {
    const code = `
      import { isRecord } from "@stanley2058/lilac-utils";
      function decodeService(value: unknown): value is { id: string } {
        return typeof value === "object" && value !== null && !Array.isArray(value)
          && "id" in value && typeof value.id === "string";
      }
      function hasRunCapability(value: unknown): value is { run(): void } {
        return isRecord(value) && typeof value.run === "function";
      }
      function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
        return isRecord(value) ? value : undefined;
      }
      function decodeNamed(value: unknown): { id: string } | undefined {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
        if (!("id" in value) || typeof value.id !== "string") return undefined;
        return value as { id: string };
      }
      const capabilities = {
        runnable: (value: unknown): { run(): void } | undefined => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
          if (!("run" in value) || typeof value.run !== "function") return undefined;
          return value as { run(): void };
        },
      };
    `;
    expect(
      findLocalRecordGuardViolations(code, "apps/example/src/decoders.ts", policyWith()),
    ).toEqual([]);
  });
});

describe("Oxlint production syntax activation", () => {
  it("enables production-only syntax rules and preserves generated exclusions", () => {
    const config = JSON.parse(
      readFileSync(new URL("../../.oxlintrc.json", import.meta.url), "utf8"),
    );
    const productionOverride = config.overrides.find((override: { files?: string[] }) =>
      override.files?.includes("apps/**/*.{js,jsx,cjs,mjs,ts,tsx}"),
    );
    const testOverride = config.overrides.find((override: { rules?: Record<string, string> }) =>
      Object.hasOwn(override.rules ?? {}, "lilac/no-fixed-test-wait"),
    );

    expect(config.ignorePatterns).toEqual(
      expect.arrayContaining([
        "**/dist/**",
        "**/generated/**",
        "**/vendor/**",
        "apps/core/src/ssh/remote-js/remote-runner.cjs",
      ]),
    );
    expect(productionOverride).toMatchObject({
      files: expect.arrayContaining(["packages/**/*.{js,jsx,cjs,mjs,ts,tsx}"]),
      rules: {
        "@typescript-eslint/no-explicit-any": "error",
        "lilac/no-else-after-terminal": "error",
        "lilac/prefer-switch-true-chain": "error",
        "no-nested-ternary": "error",
        "lilac/no-local-is-record": "error",
      },
    });
    expect(testOverride).toMatchObject({
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
        "lilac/no-fixed-test-wait": "error",
        "no-nested-ternary": "off",
        "lilac/no-local-is-record": "off",
      },
    });
  });
});
