import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, test } from "bun:test";
import ts from "typescript-codegen";

import {
  analyzeWorkspace,
  assertCoreFinalExceptionAdaptersResolve,
  declarationPackageName,
} from "./analyzer.ts";
import { createFingerprint } from "./fingerprint.ts";
import type {
  ApprovedExceptionAdapter,
  ArchitectureManifest,
  ExceptionAdapter,
  OpenProtocolAdapter,
  PersistedCodecRegistration,
  ResultDecoderRegistration,
  SqliteTransactionAdapterRegistration,
  ToolCodecRegistryRegistration,
  WorkspaceArchitecture,
} from "./manifest.ts";
import {
  ACTIVE_WORKSPACES,
  architectureManifest,
  assertArchitectureManifestIntegrity,
  EXACT_REGISTRATION_ARCHITECTURE_RULES,
  FINAL_PACKAGE_WIDE_ARCHITECTURE_RULES,
} from "./manifest.ts";
import type { ArchitectureDiagnostic, ArchitectureRule } from "./model.ts";
import { createCachingWorkspaceProgramFactory } from "./program.ts";
import {
  analyzeArchitecture,
  analyzeArchitectureInWorkspaceProcesses,
  analyzeArchitectureWorkspace,
  ARCHITECTURE_FINDINGS_EXIT_CODE,
  createArchitectureAnalysisContext,
  parseArchitectureWorkerCount,
} from "./runner.ts";
import { isProductionFileName } from "./source-policy.ts";
import {
  ARCHITECTURE_WORKSPACE_FIXTURE_ENV,
  ARCHITECTURE_WORKSPACE_FIXTURE_VALUE,
} from "./workspace-runner-protocol.ts";
import { WorkspaceAnalysisCache, workspaceAnalysisCacheKey } from "./workspace-analysis-cache.ts";
import {
  assertWorkspaceInventoryMatches,
  compareWorkspaceInventory,
} from "./workspace-inventory.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const FIXTURE_ROOT = path.join(import.meta.dir, "fixtures/stage0");
const FIXTURE_TSCONFIG = "scripts/architecture/fixtures/stage0/tsconfig.json";
const WORKSPACE_RUNNER = path.join(import.meta.dir, "workspace-runner.ts");
const WORKSPACE_RUNNER_FIXTURE_ROOT = "scripts/architecture/fixtures/workspace-runner";
const PERMANENT_RULE_ZONES = Object.fromEntries(
  FINAL_PACKAGE_WIDE_ARCHITECTURE_RULES.map((rule) => [rule, [{ include: "**" }]]),
);

const BASE_WORKSPACE = {
  name: "fixture",
  packageName: "architecture-fixture",
  root: "scripts/architecture/fixtures/stage0",
  tsconfig: FIXTURE_TSCONFIG,
  ruleZones: {},
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
} as const satisfies WorkspaceArchitecture;

const createWorkspaceProgram = createCachingWorkspaceProgramFactory();

function withProgramFixture<T>(
  files: Readonly<Record<string, string>>,
  run: (fixture: {
    readonly repositoryRoot: string;
    readonly workspaceRoot: string;
    readonly workspace: WorkspaceArchitecture;
  }) => T,
): T {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), "lilac-architecture-program-"));
  const workspaceRoot = path.join(repositoryRoot, "workspace");
  const workspace = {
    ...BASE_WORKSPACE,
    name: "program-fixture",
    packageName: "architecture-program-fixture",
    root: "workspace",
    tsconfig: "workspace/tsconfig.json",
  } satisfies WorkspaceArchitecture;
  try {
    for (const [relativePath, content] of Object.entries({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          noEmit: true,
        },
        include: ["**/*.ts"],
      }),
      ...files,
    })) {
      const fileName = path.join(workspaceRoot, relativePath);
      mkdirSync(path.dirname(fileName), { recursive: true });
      writeFileSync(fileName, content);
    }
    return run({ repositoryRoot, workspaceRoot, workspace });
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
}

const fixtureProgram = createWorkspaceProgram(REPOSITORY_ROOT, BASE_WORKSPACE).program;

interface WorkspaceRunnerResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runFixtureWorkspaceProcess(workspaceRoot: string): Promise<WorkspaceRunnerResult> {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, WORKSPACE_RUNNER, workspaceRoot],
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      [ARCHITECTURE_WORKSPACE_FIXTURE_ENV]: ARCHITECTURE_WORKSPACE_FIXTURE_VALUE,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function fixtureExceptionSyntaxKinds(
  direction: ExceptionAdapter["direction"],
): ApprovedExceptionAdapter["syntaxKinds"] {
  switch (direction) {
    case "signal-host":
      return ["throw-statement", "host-rejection-call", "registered-host-signal-call"];
    case "observe-panic":
      return ["panic-observation"];
  }
}

function fixtureExceptionRelationship(
  adapter: ExceptionAdapter,
): ApprovedExceptionAdapter["relationship"] {
  if (adapter.externalApi.package === "global" || adapter.externalApi.package === "Intl") {
    return "language-runtime";
  }
  if (adapter.externalApi.package === "better-result") return "panic-brand";
  if (adapter.direction === "signal-host" && adapter.category === "result-to-framework") {
    return "host-contract";
  }
  return "external-package";
}

function fixtureExceptionApproval(
  adapter: ExceptionAdapter,
  workspace: string = BASE_WORKSPACE.name,
): ApprovedExceptionAdapter {
  return {
    workspace,
    callable: adapter.identity,
    category: adapter.category,
    externalApi: adapter.externalApi,
    mode: adapter.direction,
    syntaxKinds: fixtureExceptionSyntaxKinds(adapter.direction),
    relationship: fixtureExceptionRelationship(adapter),
    provenance: "workspace-reviewed-manifest",
    reason: adapter.reason,
  };
}

function findingsFor(
  rule: ArchitectureRule,
  file: string,
  overrides: Partial<WorkspaceArchitecture> = {},
): readonly ArchitectureDiagnostic[] {
  const workspace = {
    ...BASE_WORKSPACE,
    ...overrides,
    ruleZones: { [rule]: [{ include: file }] },
  } satisfies WorkspaceArchitecture;
  return analyzeWorkspace(
    workspace,
    FIXTURE_ROOT,
    fixtureProgram,
    undefined,
    undefined,
    undefined,
    workspace.exceptionAdapters.map((adapter) => fixtureExceptionApproval(adapter)),
  );
}

function openProtocolAdapter(
  exportName: string,
  overrides: Partial<OpenProtocolAdapter> = {},
): OpenProtocolAdapter {
  return {
    identity: { module: "unions.ts", exportName },
    externalProtocol: { package: "open-protocol-sdk", exportName: "ProtocolEvent" },
    protocolParameter: 0,
    fallbackVariant: { discriminant: "kind", value: "unsupported" },
    reason: "Fixture open protocol normalization boundary.",
    ...overrides,
  };
}

function fixtureCodecRegistry(exportName: string, catalogExportName = "validFixtureEvents") {
  return {
    identity: { module: "stage4-events.ts", exportName },
    catalog: { module: "stage4-events.ts", exportName: catalogExportName },
    catalogHelper: { module: "stage4-events.ts", exportName: "defineLilacEvents" },
    registryHelper: {
      module: "stage4-events.ts",
      exportName: "createLilacEventCodecRegistry",
    },
  };
}

function fixtureRawBoundary(exportName: string) {
  return {
    identity: { module: "stage4-events.ts", exportName },
    messageType: { package: "architecture-fixture", exportName: "Message" },
    handlerParameter: 0,
    messageParameter: 0,
    contextParameter: 1,
  };
}

function fixtureDeliveryApi(exportName: string, deliveryPolicy: string) {
  return {
    identity: { module: "stage4-events.ts", exportName },
    handlerParameter: 0,
    handlerMessageParameter: 0,
    handlerContextParameter: 1,
    deliveryPolicy: { module: "stage4-events.ts", exportName: deliveryPolicy },
    deliveryErrorParameter: 0,
  };
}

function fixtureToolCodecRegistry(exportName: string): ToolCodecRegistryRegistration {
  return {
    identity: { module: "stage5-tools.ts", exportName },
    aliases: [],
    canonicalTools: { module: "stage5-tools.ts", exportName: "canonicalTuiToolNames" },
  };
}

function fixtureResultDecoder(exportName: string): ResultDecoderRegistration {
  return {
    identity: { module: "stage5-tools.ts", exportName },
    category: "projection",
    inputParameter: 0,
  };
}

describe("boundary validation rules", () => {
  test("rejects stale, broad, and fabricated final exception registrations", () => {
    const signalRegistration = (exportName: string) => ({
      identity: { module: "stage7-boundary.ts", exportName },
      category: "compatibility" as const,
      externalApi: { package: "global", exportName: "language host failure signal" },
      direction: "signal-host" as const,
      reason: "Fixture host signal.",
    });
    const verify = (exportName: string, registration = signalRegistration(exportName)): void => {
      const workspace = {
        ...BASE_WORKSPACE,
        name: "apps/core",
        exceptionAdapters: [registration],
      } satisfies WorkspaceArchitecture;
      assertCoreFinalExceptionAdaptersResolve(
        workspace,
        FIXTURE_ROOT,
        fixtureProgram,
        fixtureProgram.getTypeChecker(),
        [["stage7-boundary.ts", exportName, "signal"]],
        [],
        [],
      );
    };

    expect(() => verify("signalExceptionBoundary")).not.toThrow();
    expect(() => verify("ClassFieldExceptionBoundary.signal")).not.toThrow();
    expect(() => verify("missingExceptionBoundary")).toThrow("does not resolve to production code");
    expect(() => verify("unrelatedExceptionBoundary")).toThrow(
      "has no smallest-callable signal-host relationship",
    );
    expect(() =>
      verify("signalExceptionBoundary", {
        ...signalRegistration("signalExceptionBoundary"),
        externalApi: { package: "global", exportName: "fabricated signal" },
      }),
    ).toThrow("has fabricated or mismatched signal-host metadata");
  });

  test("validates every exception adapter registration outside the Core catalogs", () => {
    const registration = (exportName: string, externalExportName: string) => ({
      identity: { module: "stage7-boundary.ts", exportName },
      category: "compatibility" as const,
      externalApi: { package: "global", exportName: externalExportName },
      direction: "signal-host" as const,
      reason: "Fixture host signal.",
    });
    const verify = (adapter: ReturnType<typeof registration>, approved = true): void => {
      const workspaceName = "apps/tool-bridge";
      analyzeWorkspace(
        { ...BASE_WORKSPACE, name: workspaceName, exceptionAdapters: [adapter] },
        FIXTURE_ROOT,
        fixtureProgram,
        undefined,
        undefined,
        undefined,
        approved ? [fixtureExceptionApproval(adapter, workspaceName)] : [],
      );
    };

    expect(() =>
      verify(registration("missingExceptionBoundary", "language host failure signal")),
    ).toThrow("does not resolve to production code");
    expect(() =>
      verify(registration("unrelatedExceptionBoundary", "language host failure signal")),
    ).toThrow("has no recognizable externalApi or host relationship");
    expect(() =>
      verify(registration("signalExceptionBoundary", "language host failure signal"), false),
    ).toThrow("is not an exact member of the approved global catalog");
    expect(() =>
      verify({
        ...registration("signalExceptionBoundary", "operation"),
        externalApi: { package: "fixture-sdk", exportName: "operation" },
      }),
    ).toThrow("has no recognizable externalApi or host relationship");
  });

  test("rejects a non-Core generic adapter appended outside the approved global catalog", () => {
    const forgedAdapter = {
      identity: { module: "client.ts", exportName: "captureBridgeFailure" },
      category: "compatibility" as const,
      externalApi: { package: "global", exportName: "language host failure signal" },
      direction: "signal-host" as const,
      reason: "Copied generic host signal metadata.",
    };
    const forgedManifest: ArchitectureManifest = {
      ...architectureManifest,
      workspaces: architectureManifest.workspaces.map((workspace) =>
        workspace.name === "apps/tool-bridge"
          ? { ...workspace, exceptionAdapters: [...workspace.exceptionAdapters, forgedAdapter] }
          : workspace,
      ),
    };

    expect(() => assertArchitectureManifestIntegrity(forgedManifest)).toThrow(
      "is not an exact member of the approved global catalog",
    );
  });

  test("rejects copied generic adapter approval when the required digest is omitted", () => {
    const forgedAdapter = {
      identity: { module: "client.ts", exportName: "captureBridgeFailure" },
      category: "compatibility" as const,
      externalApi: { package: "global", exportName: "language host failure signal" },
      direction: "signal-host" as const,
      reason: "Copied generic host signal metadata and approval.",
    };
    const forgedManifest = {
      version: architectureManifest.version,
      approvedExceptionAdapters: [
        ...architectureManifest.approvedExceptionAdapters,
        fixtureExceptionApproval(forgedAdapter, "apps/tool-bridge"),
      ],
      workspaces: architectureManifest.workspaces.map((workspace) =>
        workspace.name === "apps/tool-bridge"
          ? { ...workspace, exceptionAdapters: [...workspace.exceptionAdapters, forgedAdapter] }
          : workspace,
      ),
    };

    expect(() =>
      // @ts-expect-error catalog and digest are an inseparable manifest contract
      assertArchitectureManifestIntegrity(forgedManifest),
    ).toThrow("must declare the approved global catalog and its exact digest");
  });

  test("rejects appended registration and approval when the catalog digest is stale", () => {
    const forgedAdapter = {
      identity: { module: "client.ts", exportName: "captureBridgeFailure" },
      category: "compatibility" as const,
      externalApi: { package: "global", exportName: "language host failure signal" },
      direction: "signal-host" as const,
      reason: "Copied generic host signal metadata and approval with stale digest.",
    };
    const forgedManifest: ArchitectureManifest = {
      ...architectureManifest,
      approvedExceptionAdapters: [
        ...architectureManifest.approvedExceptionAdapters,
        fixtureExceptionApproval(forgedAdapter, "apps/tool-bridge"),
      ],
      workspaces: architectureManifest.workspaces.map((workspace) =>
        workspace.name === "apps/tool-bridge"
          ? { ...workspace, exceptionAdapters: [...workspace.exceptionAdapters, forgedAdapter] }
          : workspace,
      ),
    };

    expect(() => assertArchitectureManifestIntegrity(forgedManifest)).toThrow(
      "Approved global exception adapter catalog digest mismatch",
    );
  });

  test("resolves imported schemas and aliases but permits registered decoder ownership", () => {
    const findings = findingsFor("architecture/no-unregistered-decoder", "**", {
      boundaryDecoders: [
        {
          identity: { module: "boundary.ts", exportName: "registeredDecode" },
          category: "request",
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location?.line).toBe(18);
    expect(findings[0]?.suggestion).toContain("registered boundary decoder");
  });

  test("tracks unknown member reads to exact registered boundary interpreters", () => {
    const findings = findingsFor("architecture/no-unknown-member-read", "stage7-boundary.ts", {
      boundaryDecoders: [
        {
          identity: { module: "stage7-boundary.ts", exportName: "registeredCustomMember" },
          category: "request",
        },
        {
          identity: { module: "stage7-boundary.ts", exportName: "registeredCollectStrings" },
          category: "request",
        },
        {
          identity: { module: "stage7-boundary.ts", exportName: "registeredCollectReflect" },
          category: "request",
        },
      ],
    });
    const identities = findings.map(({ identity }) => identity);
    for (const symbol of [
      "readUnknownMember",
      "destructureUnknownMember",
      "decodeCustomMember",
      "iterateUnknown",
      "spreadUnknown",
      "objectValuesUnknown",
      "objectEntriesUnknown",
      "objectSpreadUnknown",
      "collectStrings",
      "collectAliased",
      "collectReflect",
      "collectBound",
      "collectObjectCallApply",
      "collectReflectCall",
      "collectReflectBound",
      "collectCoercerApply",
      "collectCoercerBound",
    ]) {
      expect(identities.some((identity) => identity.includes(`#${symbol}`))).toBeTrue();
    }
    const hasOperation = (symbol: string, operation: string): boolean =>
      findings.some(
        (finding) =>
          finding.identity.includes(`#${symbol}`) &&
          finding.message.includes(`Operation ${operation}`),
      );
    for (const operation of [
      "values.call(Object, value)",
      "values.apply(Object, [value])",
      "entries.call(Object, value)",
      "entries.apply(Object, [value])",
    ]) {
      expect(hasOperation("collectObjectCallApply", operation)).toBeTrue();
    }
    for (const operation of ["values(value)", "entries(value)", "stringify(item)"]) {
      expect(hasOperation("collectBound", operation)).toBeTrue();
    }
    for (const operation of [
      'get.call(Reflect, value, "id")',
      'get.apply(Reflect, [value, "count"])',
      'has.apply(Reflect, [value, "label"])',
      'has.call(Reflect, value, "name")',
    ]) {
      expect(hasOperation("collectReflectCall", operation)).toBeTrue();
    }
    for (const operation of ['get(value, "id")', 'has(value, "label")']) {
      expect(hasOperation("collectReflectBound", operation)).toBeTrue();
    }
    for (const operation of [
      'String.apply(undefined, [Reflect.get(value, "id")])',
      'Number.apply(undefined, [Reflect.get(value, "count")])',
      'Boolean.apply(undefined, [Reflect.get(value, "active")])',
    ]) {
      expect(hasOperation("collectCoercerApply", operation)).toBeTrue();
    }
    for (const operation of [
      "String.call(undefined, reflectedId)",
      "Number.call(undefined, reflectedCount)",
      'Boolean.call(undefined, get.call(Reflect, value, "active"))',
    ]) {
      expect(hasOperation("collectReflectCall", operation)).toBeTrue();
    }
    for (const operation of [
      'stringify(Reflect.get(value, "id"))',
      'toNumber(Reflect.get(value, "count"))',
      'toBoolean(Reflect.get(value, "active"))',
    ]) {
      expect(hasOperation("collectCoercerBound", operation)).toBeTrue();
    }
    expect(
      identities.some((identity) => identity.includes("#registeredCollectStrings")),
    ).toBeFalse();
    expect(identities.some((identity) => identity.includes("#collectTypedStrings"))).toBeFalse();
    expect(identities.some((identity) => identity.includes("#collectTypedEntries"))).toBeFalse();
    expect(identities.some((identity) => identity.includes("#collectTypedCoercions"))).toBeFalse();
    expect(
      identities.some((identity) => identity.includes("#collectTypedWrapperMatrix")),
    ).toBeFalse();
    expect(
      identities.some((identity) => identity.includes("#registeredCollectReflect")),
    ).toBeFalse();
  });

  test("requires exact provenance for custom decoders with unknown-bearing inputs", () => {
    const findings = findingsFor(
      "architecture/no-unregistered-custom-decoder",
      "stage7-boundary.ts",
      {
        boundaryDecoders: [
          {
            identity: { module: "stage7-boundary.ts", exportName: "registeredCustomMember" },
            category: "request",
          },
          {
            identity: { module: "stage7-boundary.ts", exportName: "registeredCollectStrings" },
            category: "request",
          },
          {
            identity: { module: "stage7-boundary.ts", exportName: "registeredCollectReflect" },
            category: "request",
          },
        ],
      },
    );
    expect(findings.map(({ identity }) => identity)).toEqual([
      expect.stringContaining("#decodeCustomMember"),
      expect.stringContaining("#collectStrings"),
      expect.stringContaining("#collectAliased"),
      expect.stringContaining("#collectReflect"),
      expect.stringContaining("#collectBound"),
      expect.stringContaining("#collectObjectCallApply"),
      expect.stringContaining("#collectReflectCall"),
      expect.stringContaining("#collectReflectBound"),
      expect.stringContaining("#collectCoercerApply"),
      expect.stringContaining("#collectCoercerBound"),
    ]);
  });

  test("rejects domain unknown including z.input while allowing typed output and reasoned opaque utilities", () => {
    const findings = findingsFor("architecture/no-domain-unknown", "domain.ts", {
      opaqueUnknown: [
        {
          identity: { module: "domain.ts", exportName: "opaqueStringify" },
          reason: "This utility preserves an opaque value and only requests String coercion.",
        },
      ],
    });
    const names = findings.map((finding) => finding.message);
    expect(names.some((message) => message.includes("consumeUnknown"))).toBeFalse();
    expect(findings.some((finding) => finding.location?.line === 9)).toBeTrue();
    expect(findings.some((finding) => finding.location?.line === 13)).toBeTrue();
    expect(findings.some((finding) => finding.location?.line === 17)).toBeFalse();
    expect(findings.some((finding) => finding.location?.line === 21)).toBeFalse();
  });

  test("matches reasoned opaque interface methods without exempting their module", () => {
    const findings = findingsFor("architecture/no-domain-unknown", "domain.ts", {
      opaqueUnknown: [
        {
          identity: { module: "domain.ts", exportName: "OpaqueContract.accept" },
          reason: "Fixture interface method deliberately accepts an opaque extension value.",
        },
      ],
    });
    expect(findings.some((finding) => finding.location?.line === 51)).toBeFalse();
    expect(findings.some((finding) => finding.location?.line === 52)).toBeTrue();
  });

  test("matches reasoned opaque function-valued type properties exactly", () => {
    const findings = findingsFor("architecture/no-domain-unknown", "domain.ts", {
      opaqueUnknown: [
        {
          identity: { module: "domain.ts", exportName: "OpaqueFunctionContract.accept" },
          reason: "Fixture function property deliberately accepts an opaque extension value.",
        },
      ],
    });
    expect(findings.some((finding) => finding.location?.line === 56)).toBeFalse();
    expect(findings.some((finding) => finding.location?.line === 57)).toBeTrue();
  });

  test("does not exempt unknown parameters through exception capture registrations", () => {
    const findings = findingsFor("architecture/no-domain-unknown", "exception-adapter.ts");
    expect(findings).toHaveLength(2);
    expect(findings.some(({ message }) => message.includes("error"))).toBeTrue();
    expect(findings.some(({ message }) => message.includes("payload"))).toBeTrue();
  });

  test("rejects only structured assertions whose resolved source is unknown", () => {
    const findings = findingsFor("architecture/no-unknown-assertion", "domain.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location?.line).toBe(26);
  });

  test("handles overloads and callbacks and permits exact capability predicates", () => {
    const findings = findingsFor("architecture/no-rich-unknown-predicate", "domain.ts", {
      capabilityPredicates: [
        {
          identity: { module: "domain.ts", exportName: "isCapability" },
          reason: "Checks the exact optional protocol capability before adapter normalization.",
        },
      ],
    });
    expect(findings.map((finding) => finding.message)).toEqual([
      "Predicate isDomain promises a structured type from unknown.",
      "Predicate overloaded promises a structured type from unknown.",
      "Predicate filter.<callback@1> promises a structured type from unknown.",
    ]);
  });

  test("does not resolve unrelated calls or functions without explicit predicates", () => {
    const checker = fixtureProgram.getTypeChecker();
    let resolvedCalls = 0;
    let resolvedPredicates = 0;
    const instrumentedChecker = new Proxy(checker, {
      get(target, property, receiver) {
        if (property === "getResolvedSignature") {
          return (...parameters: Parameters<ts.TypeChecker["getResolvedSignature"]>) => {
            resolvedCalls += 1;
            return target.getResolvedSignature(...parameters);
          };
        }
        if (property === "getSignatureFromDeclaration") {
          return (...parameters: Parameters<ts.TypeChecker["getSignatureFromDeclaration"]>) => {
            resolvedPredicates += 1;
            return target.getSignatureFromDeclaration(...parameters);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const instrumentedProgram = new Proxy(fixtureProgram, {
      get(target, property, receiver) {
        if (property === "getTypeChecker") return () => instrumentedChecker;
        return Reflect.get(target, property, receiver);
      },
    });
    const workspace = {
      ...BASE_WORKSPACE,
      ruleZones: {
        "architecture/no-production-unwrap": [{ include: "performance.ts" }],
        "architecture/no-rich-unknown-predicate": [{ include: "performance.ts" }],
      },
    } satisfies WorkspaceArchitecture;

    expect(analyzeWorkspace(workspace, FIXTURE_ROOT, instrumentedProgram)).toHaveLength(0);
    expect(resolvedCalls).toBe(0);
    expect(resolvedPredicates).toBe(0);
  });
});

describe("failure flow rules", () => {
  test("resolves instance and aliased unsafe Result extraction", () => {
    const findings = findingsFor("architecture/no-production-unwrap", "result.ts");
    expect(findings).toHaveLength(4);
  });

  test("approves object capture intrinsically but rejects unbounded errors and exception channels", () => {
    const signalAdapter = {
      identity: { module: "result.ts", exportName: "signalResultCaptureFailure" },
      category: "result-to-framework" as const,
      externalApi: { package: "global", exportName: "language host failure signal" },
      direction: "signal-host" as const,
      reason: "Fixture host signal contract.",
    };
    const findings = findingsFor("architecture/no-unmapped-result-capture", "result.ts", {
      exceptionAdapters: [signalAdapter],
    });
    expect(
      findings.filter(({ message }) => message.includes("exposes UnhandledException")),
    ).toHaveLength(2);
    expect(
      findings.filter(({ message }) => message.includes("explicitly throws, rejects, or signals")),
    ).toHaveLength(11);
    expect(
      findings.some(({ identity }) => identity.includes("mappedCaptureThroughArbitraryHelper")),
    ).toBeFalse();
    expect(
      findings.some(({ identity }) => identity.includes("nestedObjectCaptureInCatchMapper")),
    ).toBeFalse();
    expect(
      findings.filter(({ identity }) => identity.includes("nestedThrowingCaptureInCatchMapper")),
    ).toHaveLength(2);
    expect(
      findings.some(({ identity }) => identity.includes("unrelatedRejectMethodCatchMapper")),
    ).toBeFalse();
    expect(
      findings.some(({ identity }) => identity.includes("declaredUnresolvedCatchMapper")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("importedUnresolvedCatchMapper")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("directDeclaredUnresolvedCatchMapper")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("directImportedUnresolvedCatchMapper")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("localResultAliasUnknownBypass")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("reassignedResultUnknownBypass")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("transitiveReassignedCatchMapper")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("dynamicOptionsCatchMapper")),
    ).toBeTrue();
  });

  test("grants unknown ownership only to direct immutable capture imports and mappers", () => {
    const findings = findingsFor("architecture/no-domain-unknown", "result.ts");
    expect(
      findings.some(({ identity }) => identity.includes("fakeResultUnknownBypass")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("unrelatedUnknownInCaptureScope")),
    ).toBeTrue();
    expect(findings.some(({ identity }) => identity.includes("mappedUnknownCapture"))).toBeFalse();
    expect(findings.some(({ identity }) => identity.includes("importAliasedCapture"))).toBeFalse();
    expect(
      findings.some(({ identity }) => identity.includes("namedCapturedCauseMapper")),
    ).toBeFalse();
    expect(findings.some(({ identity }) => identity.includes("classifyCapturedCause"))).toBeFalse();
    expect(
      findings.filter(({ identity }) => identity.includes("classifyInlineCapturedThunk")),
    ).toEqual([]);
    expect(
      findings.some(({ identity }) => identity.includes("classifyCapturedMapError")),
    ).toBeFalse();
    expect(
      findings.some(({ identity }) => identity.includes("classifyUnrelatedClosedWrapper")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("ancestorCaptureDoesNotOwnUnknown")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("classifyMixedCapturedCause")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("classifyMixedCapturedComposite")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("locallyAliasedCapturedCauseMapper")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("reassignedCapturedCauseMapper")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("localResultAliasUnknownBypass")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("reassignedResultUnknownBypass")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("classifyConditionallyAssignedCause")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("classifyMultiplyAssignedCause")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("classifyCompoundAssignedCause")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("classifyDestructuringAssignedCause")),
    ).toBeTrue();
  });

  test("rejects indirect mutation of a direct better-result import binding", () => {
    const domainFindings = findingsFor("architecture/no-domain-unknown", "result-mutation.ts");
    expect(
      domainFindings.some(({ identity }) => identity.includes("mutatedImportedResultCapture")),
    ).toBeTrue();
    const captureFindings = findingsFor(
      "architecture/no-unmapped-result-capture",
      "result-mutation.ts",
    );
    expect(captureFindings).toHaveLength(1);
    expect(captureFindings[0]?.message).toContain("direct immutable better-result import");
  });

  test("follows closed captured output through immediate match, helper, and thunk classification", () => {
    const findings = findingsFor("architecture/no-unknown-member-read", "result.ts");
    expect(
      findings.some(({ identity }) => identity.includes("mappedCaptureThroughProjectionHelper")),
    ).toBeFalse();
    expect(
      findings.some(({ identity }) => identity.includes("mappedCaptureThroughUnrelatedProjection")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("mappedCaptureOutcomeRead")),
    ).toBeFalse();
    expect(
      findings.some(({ identity }) => identity.includes("classifyNamedCapturedWrapperOutside")),
    ).toBeFalse();
    expect(
      findings.filter(({ identity }) => identity.includes("classifyInlineCapturedThunk")),
    ).toEqual([]);
    expect(
      findings.some(({ identity }) => identity.includes("classifyCapturedMapError")),
    ).toBeFalse();
    expect(
      findings.some(({ identity }) => identity.includes("classifyUnrelatedClosedWrapper")),
    ).toBeTrue();
    expect(
      findings.some(({ identity }) => identity.includes("ancestorCaptureDoesNotOwnUnknown")),
    ).toBeTrue();
  });

  test("does not let signal registrations authorize unknown interpretation", () => {
    const signalAdapter = {
      identity: { module: "signal-unknown.ts", exportName: "signalUnknown" },
      category: "result-to-framework" as const,
      externalApi: { package: "global", exportName: "language host failure signal" },
      direction: "signal-host" as const,
      reason: "Fixture signal contract.",
    };
    const findings = findingsFor("architecture/no-domain-unknown", "signal-unknown.ts", {
      exceptionAdapters: [signalAdapter],
    });
    expect(findings).toHaveLength(1);
  });

  test("requires exact Panic observation instead of text or panic-like helper names", () => {
    const observer = (exportName: string) => ({
      identity: { module: "stage7-boundary.ts", exportName },
      category: "defect-supervisor" as const,
      externalApi: { package: "better-result", exportName: "Panic.is" },
      direction: "observe-panic" as const,
      reason: "Fixture exact Panic observer.",
    });
    const verify = (exportName: string): void => {
      const adapter = observer(exportName);
      analyzeWorkspace(
        { ...BASE_WORKSPACE, exceptionAdapters: [adapter] },
        FIXTURE_ROOT,
        fixtureProgram,
        undefined,
        undefined,
        undefined,
        [fixtureExceptionApproval(adapter)],
      );
    };

    expect(() => verify("exactPanicObserver")).not.toThrow();
    expect(() => verify("stringOnlyPanicObserver")).toThrow(
      "has no recognizable externalApi or host relationship",
    );
    expect(() => verify("staleNamedPanicObserver")).toThrow(
      "has no recognizable externalApi or host relationship",
    );
    expect(() => verify("unrelatedPanicObserver")).toThrow(
      "has no recognizable externalApi or host relationship",
    );
    expect(() => verify("discardedPanicObserver")).toThrow(
      "has no recognizable externalApi or host relationship",
    );
    expect(() => verify("negatedPanicObserver")).toThrow(
      "has no recognizable externalApi or host relationship",
    );
    expect(() => verify("mixedControlPanicObserver")).toThrow(
      "has no recognizable externalApi or host relationship",
    );
    expect(() => verify("commonRootDifferentCauseObserver")).toThrow(
      "has no recognizable externalApi or host relationship",
    );
    expect(() => verify("elseBranchPanicObserver")).toThrow(
      "has no recognizable externalApi or host relationship",
    );
    expect(() => verify("partialBranchPanicObserver")).toThrow(
      "has no recognizable externalApi or host relationship",
    );
  });

  test("registers Panic by movement-tolerant exact callsite fingerprint", () => {
    const initial = findingsFor("architecture/registered-panic-site", "result.ts");
    expect(initial).toHaveLength(2);
    const findings = findingsFor("architecture/registered-panic-site", "result.ts", {
      panicSites: [
        {
          fingerprint: initial[0]?.fingerprint ?? "missing",
          reason: "The fixture proves exact hard-invariant registration.",
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fingerprint).not.toBe(initial[0]?.fingerprint);
  });

  test("uses resolved Result and TaggedError types only at registered outputs", () => {
    const findings = findingsFor("architecture/no-result-wire-leak", "result.ts", {
      compatibilityOutputs: [
        {
          sink: { kind: "external", package: "wire-api", exportName: "send" },
          category: "worker",
          reason: "The worker wire contract predates better-result.",
        },
        {
          sink: { kind: "local", module: "result.ts", exportName: "localJsonResponse" },
          category: "http",
          reason: "The HTTP response shape predates better-result.",
        },
      ],
    });
    expect(findings).toHaveLength(4);
    expect(findings.some((finding) => finding.message.includes("worker"))).toBeTrue();
    expect(findings.some((finding) => finding.message.includes("http"))).toBeTrue();
  });
});

describe("Stage 2 union rules", () => {
  test("requires exhaustive project-owned switches across imports, aliases, discriminants, and generics", () => {
    const findings = findingsFor("architecture/closed-union-exhaustiveness", "unions.ts");
    expect(findings).toHaveLength(11);
    expect(findings.some((finding) => finding.message.includes('missing "complete"'))).toBeTrue();
    expect(findings.some((finding) => finding.message.includes('missing "deleted"'))).toBeTrue();
    expect(
      findings.some((finding) => finding.message.includes("uses a silent default")),
    ).toBeTrue();
    expect(findings.every((finding) => finding.suggestion.includes("never sink"))).toBeTrue();
    expect(findings.some((finding) => finding.identity.includes("thirdPartySwitch"))).toBeFalse();
    expect(
      findings.some((finding) => finding.identity.includes("launderedThirdPartySwitch")),
    ).toBeFalse();
    expect(
      findings.some((finding) => finding.identity.includes("wrappedThirdPartySwitch")),
    ).toBeFalse();
    expect(
      findings.some((finding) => finding.identity.includes("exhaustiveWithNeverSink")),
    ).toBeFalse();
    expect(
      findings.some((finding) => finding.identity.includes("exhaustivePropertyWithNeverSink")),
    ).toBeFalse();
    expect(findings.some((finding) => finding.identity.includes("unrelatedNeverSink"))).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("incompleteInferredSwitch")),
    ).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("incompleteInferredFunctionSwitch")),
    ).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("incompleteInferredObjectSwitch")),
    ).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("incompleteShorthandObjectSwitch")),
    ).toBeTrue();
  });

  test("follows imported maps and accepts checked imported and intermediate assignments", () => {
    const findings = findingsFor("architecture/closed-union-map-exhaustiveness", "unions.ts");
    expect(findings).toHaveLength(7);
    expect(findings.every((finding) => finding.message.includes("compiler-checked"))).toBeTrue();
    expect(findings.some((finding) => finding.location?.file === "union-types.ts")).toBeTrue();
    expect(findings.filter((finding) => finding.location?.file === "union-types.ts")).toHaveLength(
      2,
    );
  });

  test("deduplicates exhaustive map findings by source file and position", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      ruleZones: {
        "architecture/closed-union-map-exhaustiveness": [
          { include: "map-a.ts" },
          { include: "map-b.ts" },
        ],
      },
    } satisfies WorkspaceArchitecture;
    const findings = analyzeWorkspace(workspace, FIXTURE_ROOT, fixtureProgram);
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.location?.file).sort()).toEqual([
      "map-a.ts",
      "map-b.ts",
    ]);
  });

  test("checks unindexed nested map property assignments and preserves exhaustive contracts", () => {
    const findings = findingsFor("architecture/closed-union-map-exhaustiveness", "nested-maps.ts");
    expect(findings).toHaveLength(7);
    expect(findings.every((finding) => finding.location?.file === "nested-maps.ts")).toBeTrue();
    expect(findings.every((finding) => finding.message.includes("compiler-checked"))).toBeTrue();
  });

  test("validates exact external input, closed local output, and explicit open fallback", () => {
    const valid = findingsFor("architecture/open-protocol-normalization", "unions.ts", {
      openProtocolAdapters: [openProtocolAdapter("normalizeProtocolEvent")],
    });
    expect(valid).toEqual([]);

    const missingFallback = findingsFor("architecture/open-protocol-normalization", "unions.ts", {
      openProtocolAdapters: [
        openProtocolAdapter("normalizeProtocolEvent"),
        openProtocolAdapter("normalizeWithoutExplicitFallback"),
      ],
    });
    expect(missingFallback).toHaveLength(1);
    expect(missingFallback[0]?.message).toContain("never explicitly returns");

    const wrongInput = findingsFor("architecture/open-protocol-normalization", "unions.ts", {
      openProtocolAdapters: [
        openProtocolAdapter("normalizeProtocolEvent"),
        openProtocolAdapter("normalizeLocalValue"),
      ],
    });
    expect(wrongInput).toHaveLength(1);
    expect(wrongInput[0]?.message).toContain("not the named external protocol");

    const aliasInput = findingsFor("architecture/open-protocol-normalization", "unions.ts", {
      openProtocolAdapters: [
        openProtocolAdapter("normalizeProtocolEvent"),
        openProtocolAdapter("normalizeAliasedProtocolEvent"),
      ],
    });
    expect(aliasInput).toEqual([]);

    const genericInput = findingsFor("architecture/open-protocol-normalization", "unions.ts", {
      openProtocolAdapters: [
        openProtocolAdapter("normalizeProtocolEvent"),
        openProtocolAdapter("normalizeGenericProtocolEvent", {
          externalProtocol: {
            package: "open-protocol-sdk",
            exportName: "GenericProtocolEvent",
          },
        }),
      ],
    });
    expect(genericInput).toEqual([]);

    const externalGenericOutput = findingsFor(
      "architecture/open-protocol-normalization",
      "unions.ts",
      {
        openProtocolAdapters: [
          openProtocolAdapter("normalizeProtocolEvent"),
          openProtocolAdapter("normalizeGenericProtocolEvent", {
            externalProtocol: {
              package: "open-protocol-sdk",
              exportName: "GenericProtocolEvent",
            },
          }),
          openProtocolAdapter("normalizeToExternalGenericVariants", {
            externalProtocol: {
              package: "open-protocol-sdk",
              exportName: "GenericProtocolEvent",
            },
          }),
        ],
      },
    );
    expect(externalGenericOutput).toHaveLength(1);
    expect(externalGenericOutput[0]?.message).toContain(
      "return type is not a project-owned closed discriminated union",
    );

    for (const exportName of ["normalizeWrappedProtocolEvent", "normalizeUnionProtocolEvent"]) {
      const inexact = findingsFor("architecture/open-protocol-normalization", "unions.ts", {
        openProtocolAdapters: [
          openProtocolAdapter("normalizeProtocolEvent"),
          openProtocolAdapter(exportName),
        ],
      });
      expect(inexact).toHaveLength(1);
      expect(inexact[0]?.message).toContain("not the named external protocol");
    }
  });

  test("rejects direct external protocol switching outside the exact adapter", () => {
    const findings = findingsFor("architecture/open-protocol-normalization", "open-consumer.ts", {
      openProtocolAdapters: [openProtocolAdapter("normalizeProtocolEvent")],
    });
    expect(findings).toHaveLength(4);
    expect(findings.every((finding) => finding.message.includes("switched directly"))).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("consumeProtocolDirectly")),
    ).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("consumeAliasedProtocolDirectly")),
    ).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("consumeDestructuredProtocolDirectly")),
    ).toBeTrue();
    expect(
      findings.some((finding) =>
        finding.identity.includes("consumePropertyAliasedProtocolDirectly"),
      ),
    ).toBeTrue();
    expect(
      findings.every((finding) =>
        finding.suggestion.includes("exactly registered open-protocol adapter"),
      ),
    ).toBeTrue();
  });

  test("fails stale open-protocol registrations that do not resolve to a callable", () => {
    expect(() =>
      findingsFor("architecture/open-protocol-normalization", "unions.ts", {
        openProtocolAdapters: [openProtocolAdapter("misspelledProtocolAdapter")],
      }),
    ).toThrow("must resolve to exactly one callable implementation; found 0");
  });

  test("requires nonempty unique open-protocol registrations", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      ruleZones: {
        ...PERMANENT_RULE_ZONES,
        "architecture/open-protocol-normalization": [{ include: "unions.ts" }],
      },
      openProtocolAdapters: [openProtocolAdapter("normalizeProtocolEvent")],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [workspace] }),
    ).not.toThrow();
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...workspace,
            openProtocolAdapters: [
              openProtocolAdapter("normalizeProtocolEvent"),
              openProtocolAdapter("normalizeProtocolEvent"),
            ],
          },
        ],
      }),
    ).toThrow("Duplicate open-protocol adapter registration");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...workspace,
            openProtocolAdapters: [openProtocolAdapter("normalizeProtocolEvent", { reason: "" })],
          },
        ],
      }),
    ).toThrow("reason must be nonempty");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...workspace,
            ruleZones: {
              ...PERMANENT_RULE_ZONES,
              "architecture/open-protocol-normalization": [{ include: "consumer.ts" }],
            },
          },
        ],
      }),
    ).toThrow("exact architecture/open-protocol-normalization zones must equal registered modules");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...workspace,
            ruleZones: {
              ...PERMANENT_RULE_ZONES,
              "architecture/open-protocol-normalization": [{ include: "**" }],
            },
          },
        ],
      }),
    ).toThrow("exact architecture/open-protocol-normalization zones must equal registered modules");
  });

  test("requires exact reasoned and exception-adapter registrations", () => {
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...BASE_WORKSPACE,
            ruleZones: PERMANENT_RULE_ZONES,
            opaqueUnknown: [
              { identity: { module: "domain.ts", exportName: "<module>" }, reason: "broad" },
            ],
          },
        ],
      }),
    ).toThrow("must name an exact symbol");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        approvedExceptionAdapters: architectureManifest.approvedExceptionAdapters,
        approvedExceptionAdapterCatalogSha256:
          architectureManifest.approvedExceptionAdapterCatalogSha256,
        workspaces: [
          {
            ...BASE_WORKSPACE,
            ruleZones: PERMANENT_RULE_ZONES,
            exceptionAdapters: [
              {
                identity: { module: "adapter.ts", exportName: "signalFailure" },
                category: "result-to-framework",
                externalApi: { package: "fixture", exportName: "host failure contract" },
                direction: "signal-host",
                reason: "",
              },
            ],
          },
        ],
      }),
    ).toThrow("reason must be nonempty");
  });

  test("excludes the generated Core remote runner bundle but not its source", () => {
    const root = path.join(REPOSITORY_ROOT, "apps/core");
    expect(
      isProductionFileName(path.join(root, "src/ssh/remote-js/remote-runner.cjs"), root),
    ).toBeFalse();
    expect(
      isProductionFileName(path.join(root, "src/ssh/remote-js/remote-runner-entry.ts"), root),
    ).toBeTrue();
    expect(isProductionFileName(path.join(root, "test/support.ts"), root)).toBeFalse();
    expect(isProductionFileName(path.join(root, "tests/support.ts"), root)).toBeFalse();
    expect(isProductionFileName(path.join(root, "__tests__/support.ts"), root)).toBeFalse();
    expect(isProductionFileName(path.join(root, "src/generated/output.ts"), root)).toBeFalse();
    expect(isProductionFileName(path.join(root, "src/fixtures/production.ts"), root)).toBeTrue();
    expect(isProductionFileName(path.join(root, "tests/fixtures/support.ts"), root)).toBeFalse();
    expect(isProductionFileName(path.join(root, "src/vendor/library.ts"), root)).toBeFalse();
  });
});

describe("Stage 4 event architecture rules", () => {
  test("checks event infrastructure identities and parameter indexes", () => {
    const registry = fixtureCodecRegistry("validFixtureEventCodecs");
    const validWorkspace = {
      ...BASE_WORKSPACE,
      ruleZones: {
        ...PERMANENT_RULE_ZONES,
        "architecture/complete-event-codec-registry": [{ include: "stage4-events.ts" }],
        "architecture/event-handler-result": [{ include: "stage4-events.ts" }],
        "architecture/event-delivery-policy-exhaustiveness": [{ include: "stage4-events.ts" }],
      },
      eventCodecRegistries: [registry],
      eventDeliveryApis: [
        fixtureDeliveryApi("FixtureDeliveryApi.good", "exhaustiveDeliveryPolicy"),
      ],
      operationalResultApis: [
        { module: "stage4-events.ts", exportName: "FixtureDeliveryApi.good" },
      ],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [validWorkspace] }),
    ).not.toThrow();

    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...validWorkspace,
            ruleZones: {
              ...validWorkspace.ruleZones,
              "architecture/raw-event-message-boundary": [{ include: "stage4-events.ts" }],
            },
            rawEventMessageBoundaries: [
              { ...fixtureRawBoundary("RawFixtureBus.receiveGood"), handlerParameter: -1 },
            ],
          },
        ],
      }),
    ).toThrow("handlerParameter must be a nonnegative integer");
  });

  test("accepts an exact event catalog and derived codec registry", () => {
    const complete = findingsFor("architecture/complete-event-codec-registry", "stage4-events.ts", {
      eventCodecRegistries: [fixtureCodecRegistry("validFixtureEventCodecs")],
    });

    expect(complete).toEqual([]);
  });

  test("rejects event catalog entries with missing metadata", () => {
    const findings = findingsFor("architecture/complete-event-codec-registry", "stage4-events.ts", {
      eventCodecRegistries: [
        fixtureCodecRegistry("missingMetadataFixtureEventCodecs", "missingMetadataFixtureEvents"),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("nonempty literal family");
  });

  test("rejects duplicate event wire types", () => {
    const findings = findingsFor("architecture/complete-event-codec-registry", "stage4-events.ts", {
      eventCodecRegistries: [
        fixtureCodecRegistry(
          "duplicateWireTypeFixtureEventCodecs",
          "duplicateWireTypeFixtureEvents",
        ),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("duplicate wire type fixture.duplicate");
  });

  test("rejects spread, computed, and nonliteral event catalog input", () => {
    for (const [registry, catalog] of [
      ["spreadFixtureEventCodecs", "spreadFixtureEvents"],
      ["computedFixtureEventCodecs", "computedFixtureEvents"],
      ["nonliteralFixtureEventCodecs", "nonliteralFixtureEvents"],
      ["nonliteralMetadataFixtureEventCodecs", "nonliteralMetadataFixtureEvents"],
    ] as const) {
      const findings = findingsFor(
        "architecture/complete-event-codec-registry",
        "stage4-events.ts",
        { eventCodecRegistries: [fixtureCodecRegistry(registry, catalog)] },
      );
      expect(findings).toHaveLength(1);
    }
  });

  test("rejects the reserved __proto__ catalog entry name", () => {
    const findings = findingsFor("architecture/complete-event-codec-registry", "stage4-events.ts", {
      eventCodecRegistries: [
        fixtureCodecRegistry("reservedNameFixtureEventCodecs", "reservedNameFixtureEvents"),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("catalog entry name __proto__ is reserved");
  });

  test("rejects a catalog built by the wrong helper symbol", () => {
    const findings = findingsFor("architecture/complete-event-codec-registry", "stage4-events.ts", {
      eventCodecRegistries: [
        fixtureCodecRegistry("wrongHelperFixtureEventCodecs", "wrongHelperFixtureEvents"),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("defineLilacEvents symbol");
  });

  test("rejects a catalog built by a same-named unregistered helper", () => {
    const findings = findingsFor("architecture/complete-event-codec-registry", "stage4-events.ts", {
      eventCodecRegistries: [
        fixtureCodecRegistry("sameNameImpostorFixtureEventCodecs", "sameNameImpostorFixtureEvents"),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("registered defineLilacEvents symbol");
  });

  test("rejects a registry projected from a different catalog symbol", () => {
    const findings = findingsFor("architecture/complete-event-codec-registry", "stage4-events.ts", {
      eventCodecRegistries: [
        fixtureCodecRegistry("mismatchedFixtureEventCodecs", "validFixtureEvents"),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("registered catalog symbol");
  });

  test("rejects a registry built by the wrong projection helper symbol", () => {
    const findings = findingsFor("architecture/complete-event-codec-registry", "stage4-events.ts", {
      eventCodecRegistries: [fixtureCodecRegistry("wrongProjectionHelperFixtureEventCodecs")],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("createLilacEventCodecRegistry symbol");
  });

  test("rejects a registry built by a same-named unregistered projection helper", () => {
    const findings = findingsFor("architecture/complete-event-codec-registry", "stage4-events.ts", {
      eventCodecRegistries: [fixtureCodecRegistry("sameNameImpostorProjectionFixtureEventCodecs")],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("registered createLilacEventCodecRegistry symbol");
  });

  test("requires raw receive handlers to expose Message<unknown> without specialization assertions", () => {
    const good = findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
      rawEventMessageBoundaries: [fixtureRawBoundary("RawFixtureBus.receiveGood")],
    });
    const typed = findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
      rawEventMessageBoundaries: [fixtureRawBoundary("RawFixtureBus.receiveTyped")],
    });
    const asserted = findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
      rawEventMessageBoundaries: [fixtureRawBoundary("RawFixtureBus.receiveWithAssertion")],
    });
    const generic = findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
      rawEventMessageBoundaries: [fixtureRawBoundary("RawFixtureBus.receiveGeneric")],
    });
    const commit = findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
      rawEventMessageBoundaries: [fixtureRawBoundary("RawFixtureBus.receiveWithCommit")],
    });

    expect(good).toEqual([]);
    expect(typed).toHaveLength(1);
    expect(typed[0]?.message).toContain("Message<unknown>");
    expect(asserted).toHaveLength(1);
    expect(asserted[0]?.message).toContain("assertion");
    expect(generic.some((finding) => finding.message.includes("generic"))).toBe(true);
    expect(commit.some((finding) => finding.message.includes("context exposes commit"))).toBe(true);
  });

  test("rejects future legacy raw delivery aliases", () => {
    const findings = findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
      rawEventMessageBoundaries: [fixtureRawBoundary("LegacyRawFixtureBus.receiveGood")],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("subscribeDelivery");
  });

  test("requires Result-returning handlers and removes handler-owned commit", () => {
    const good = findingsFor("architecture/event-handler-result", "stage4-events.ts", {
      eventDeliveryApis: [
        fixtureDeliveryApi("FixtureDeliveryApi.good", "exhaustiveDeliveryPolicy"),
      ],
    });
    const bad = findingsFor("architecture/event-handler-result", "stage4-events.ts", {
      eventDeliveryApis: [fixtureDeliveryApi("FixtureDeliveryApi.bad", "exhaustiveDeliveryPolicy")],
    });

    expect(good).toEqual([]);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.message).toContain("handler context exposes commit");
    expect(bad[0]?.message).toContain("Promise<Result<void, E>>");
  });

  test("rejects future legacy delivery API aliases", () => {
    const findings = findingsFor("architecture/event-handler-result", "stage4-events.ts", {
      eventDeliveryApis: [
        fixtureDeliveryApi("LegacyFixtureDeliveryApi.good", "exhaustiveDeliveryPolicy"),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("subscribeTopicResult");
  });

  test("fails closed for unregistered production Result consumers", () => {
    const registered = {
      identity: { module: "stage4-events.ts", exportName: "registeredFixtureConsumer" },
      apiPackage: "architecture-fixture",
      operations: ["subscribeTopic"] as const,
    };
    const unregistered = {
      identity: { module: "stage4-events.ts", exportName: "unregisteredFixtureConsumer" },
      apiPackage: "architecture-fixture",
      operations: ["fetchTopic"] as const,
    };
    expect(() =>
      findingsFor("architecture/event-handler-result", "stage4-events.ts", {
        eventDeliveryConsumers: [registered, unregistered],
      }),
    ).not.toThrow();
    expect(() =>
      findingsFor("architecture/event-handler-result", "stage4-events.ts", {
        eventDeliveryConsumers: [registered],
      }),
    ).toThrow("Unregistered event delivery consumer");
  });

  test("scans workspaces with no local registrations for consumers of manifest APIs", () => {
    const apiWorkspace = {
      ...BASE_WORKSPACE,
      name: "fixture-event-api",
      packageName: "fixture-event-api",
      root: "scripts/architecture/fixtures/stage4-event-api",
      tsconfig: "scripts/architecture/fixtures/stage4-event-api/tsconfig.json",
      ruleZones: {
        ...PERMANENT_RULE_ZONES,
        "architecture/event-handler-result": [{ include: "api.ts" }],
        "architecture/event-delivery-policy-exhaustiveness": [{ include: "api.ts" }],
      },
      eventDeliveryApis: [
        {
          identity: { module: "api.ts", exportName: "FixtureEventBus.subscribeTopic" },
          handlerParameter: 0,
          handlerMessageParameter: 0,
          handlerContextParameter: 1,
          deliveryPolicy: { module: "api.ts", exportName: "fixtureDeliveryPolicy" },
          deliveryErrorParameter: 0,
        },
      ],
      operationalResultApis: [{ module: "api.ts", exportName: "FixtureEventBus.subscribeTopic" }],
    } as const satisfies WorkspaceArchitecture;
    const consumerWorkspace = {
      ...BASE_WORKSPACE,
      name: "fixture-event-consumer",
      packageName: "fixture-event-consumer",
      root: "scripts/architecture/fixtures/stage4-event-consumer",
      tsconfig: "scripts/architecture/fixtures/stage4-event-consumer/tsconfig.json",
      ruleZones: PERMANENT_RULE_ZONES,
    } as const satisfies WorkspaceArchitecture;

    expect(() =>
      analyzeArchitecture(REPOSITORY_ROOT, {
        version: 1,
        workspaces: [apiWorkspace, consumerWorkspace],
      }),
    ).toThrow(
      "Unregistered event delivery consumer in fixture-event-consumer: consumer.ts#unregisteredCrossWorkspaceConsumer calls fixture-event-api#subscribeTopic.",
    );
  });

  test("requires an exhaustive registered delivery policy", () => {
    const good = findingsFor(
      "architecture/event-delivery-policy-exhaustiveness",
      "stage4-events.ts",
      {
        eventDeliveryApis: [
          fixtureDeliveryApi("FixtureDeliveryApi.good", "exhaustiveDeliveryPolicy"),
        ],
      },
    );
    const bad = findingsFor(
      "architecture/event-delivery-policy-exhaustiveness",
      "stage4-events.ts",
      {
        eventDeliveryApis: [
          fixtureDeliveryApi("FixtureDeliveryApi.good", "incompleteDeliveryPolicy"),
        ],
      },
    );

    expect(good).toEqual([]);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.message).toContain("DeadLetterFailed");
    expect(bad[0]?.suggestion).toContain("retry");
  });

  test("fails closed when an enforced event registration drifts", () => {
    expect(() =>
      findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
        rawEventMessageBoundaries: [fixtureRawBoundary("RawFixtureBus.missing")],
      }),
    ).toThrow("must resolve to exactly one declaration; found 0");
  });
});

describe("Stage 5 presentation architecture rules", () => {
  test("requires an explicit exhaustive tool codec registry without spread, broad, missing, or extra keys", () => {
    const complete = findingsFor("architecture/complete-tool-codec-registry", "stage5-tools.ts", {
      toolCodecRegistries: [fixtureToolCodecRegistry("completeToolCodecs")],
    });
    expect(complete).toEqual([]);
    expect(
      findingsFor("architecture/complete-tool-codec-registry", "stage5-tools.ts", {
        toolCodecRegistries: [
          {
            ...fixtureToolCodecRegistry("completeToolCodecs"),
            aliases: [{ module: "stage5-tools.ts", exportName: "completeToolCodecsAlias" }],
          },
        ],
      }),
    ).toEqual([]);
    const invalidAlias = findingsFor(
      "architecture/complete-tool-codec-registry",
      "stage5-tools.ts",
      {
        toolCodecRegistries: [
          {
            ...fixtureToolCodecRegistry("completeToolCodecs"),
            aliases: [{ module: "stage5-tools.ts", exportName: "invalidToolCodecsAlias" }],
          },
        ],
      },
    );
    expect(invalidAlias).toHaveLength(1);
    expect(invalidAlias[0]?.message).toContain("aliases do not reference");

    for (const exportName of [
      "spreadToolCodecs",
      "broadToolCodecs",
      "broadTypedToolCodecs",
      "incompleteToolCodecs",
      "extraToolCodecs",
    ]) {
      const findings = findingsFor("architecture/complete-tool-codec-registry", "stage5-tools.ts", {
        toolCodecRegistries: [fixtureToolCodecRegistry(exportName)],
      });
      expect(findings).toHaveLength(1);
    }
    expect(
      findingsFor("architecture/complete-tool-codec-registry", "stage5-tools.ts", {
        toolCodecRegistries: [fixtureToolCodecRegistry("incompleteToolCodecs")],
      })[0]?.message,
    ).toContain("codecs missing");
    expect(
      findingsFor("architecture/complete-tool-codec-registry", "stage5-tools.ts", {
        toolCodecRegistries: [fixtureToolCodecRegistry("extraToolCodecs")],
      })[0]?.message,
    ).toContain("future_tool");
    expect(
      findingsFor("architecture/complete-tool-codec-registry", "stage5-tools.ts", {
        toolCodecRegistries: [fixtureToolCodecRegistry("broadTypedToolCodecs")],
      })[0]?.message,
    ).toContain("broad index signature");
    const duplicateCatalog = findingsFor(
      "architecture/complete-tool-codec-registry",
      "stage5-tools.ts",
      {
        toolCodecRegistries: [
          {
            ...fixtureToolCodecRegistry("completeToolCodecs"),
            canonicalTools: {
              module: "stage5-tools.ts",
              exportName: "duplicateCanonicalTuiToolNames",
            },
          },
        ],
      },
    );
    expect(duplicateCatalog).toHaveLength(1);
    expect(duplicateCatalog[0]?.message).toContain("catalog contains duplicates");
    const broadCatalog = findingsFor(
      "architecture/complete-tool-codec-registry",
      "stage5-tools.ts",
      {
        toolCodecRegistries: [
          {
            ...fixtureToolCodecRegistry("completeToolCodecs"),
            canonicalTools: {
              module: "stage5-tools.ts",
              exportName: "broadCanonicalTuiToolNames",
            },
          },
        ],
      },
    );
    expect(broadCatalog).toHaveLength(1);
    expect(broadCatalog[0]?.message).toContain("not a literal tuple");
  });

  test("resolves a shared cross-workspace tool catalog and reports protocol drift", () => {
    const registration = {
      ...fixtureToolCodecRegistry("completeToolCodecs"),
      canonicalTools: {
        package: "fixture-shared-protocol",
        module: "tool-catalog.ts",
        exportName: "SHARED_TOOL_NAMES",
      },
    } satisfies ToolCodecRegistryRegistration;
    const workspace = {
      ...BASE_WORKSPACE,
      ruleZones: {
        "architecture/complete-tool-codec-registry": [{ include: "stage5-tools.ts" }],
      },
      toolCodecRegistries: [registration],
    } satisfies WorkspaceArchitecture;
    const packageRoots = [
      { packageName: workspace.packageName, root: FIXTURE_ROOT },
      {
        packageName: "fixture-shared-protocol",
        root: path.join(FIXTURE_ROOT, "shared-protocol"),
      },
    ];

    expect(analyzeWorkspace(workspace, FIXTURE_ROOT, fixtureProgram, packageRoots)).toEqual([]);
    const drifted = {
      ...workspace,
      toolCodecRegistries: [
        {
          ...registration,
          canonicalTools: {
            ...registration.canonicalTools,
            exportName: "DRIFTED_SHARED_TOOL_NAMES",
          },
        },
      ],
    } satisfies WorkspaceArchitecture;
    const findings = analyzeWorkspace(drifted, FIXTURE_ROOT, fixtureProgram, packageRoots);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("future_tool");
  });

  test("rejects duplicate values, unresolved packages, and non-exact tool registry declarations in manifest integrity", () => {
    const registry = fixtureToolCodecRegistry("completeToolCodecs");
    const valid = {
      ...BASE_WORKSPACE,
      ruleZones: {
        ...PERMANENT_RULE_ZONES,
        "architecture/complete-tool-codec-registry": [{ include: "stage5-tools.ts" }],
      },
      toolCodecRegistries: [registry],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [valid] }),
    ).not.toThrow();
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [{ ...valid, toolCodecRegistries: [registry, registry] }],
      }),
    ).toThrow("Duplicate tool codec registry registration");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...valid,
            toolCodecRegistries: [{ ...registry, aliases: [registry.identity] }],
          },
        ],
      }),
    ).toThrow("Duplicate tool codec registry value registration");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...valid,
            toolCodecRegistries: [
              {
                ...registry,
                canonicalTools: {
                  package: "@fixture/missing-protocol",
                  module: "tool-catalog.ts",
                  exportName: "TOOL_NAMES",
                },
              },
            ],
          },
        ],
      }),
    ).toThrow("is not an active workspace package");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...valid,
            ruleZones: {
              ...valid.ruleZones,
              "architecture/complete-tool-codec-registry": [{ include: "stage5-*.ts" }],
            },
            toolCodecRegistries: [
              {
                ...registry,
                identity: { module: "stage5-*.ts", exportName: "completeToolCodecs" },
              },
            ],
          },
        ],
      }),
    ).toThrow("must name an exact symbol");
  });

  test("requires exact non-generic Result decoders with unknown boundary input and decoded outputs", () => {
    expect(
      findingsFor("architecture/result-decoder-contract", "stage5-tools.ts", {
        resultDecoders: [fixtureResultDecoder("decodeKnownToolObservation")],
      }),
    ).toEqual([]);
    for (const exportName of [
      "genericToolDecoder",
      "nonResultToolDecoder",
      "unknownSuccessToolDecoder",
      "unknownErrorToolDecoder",
      "nestedUnknownErrorToolDecoder",
      "nestedAnyErrorToolDecoder",
      "nestedNeverErrorToolDecoder",
      "typedInputToolDecoder",
    ]) {
      const findings = findingsFor("architecture/result-decoder-contract", "stage5-tools.ts", {
        resultDecoders: [fixtureResultDecoder(exportName)],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("invalid");
    }
  });

  test("requires Result decoder registrations to be exact and unique", () => {
    const decoder = fixtureResultDecoder("decodeKnownToolObservation");
    const valid = {
      ...BASE_WORKSPACE,
      ruleZones: {
        ...PERMANENT_RULE_ZONES,
        "architecture/result-decoder-contract": [{ include: "stage5-tools.ts" }],
      },
      resultDecoders: [decoder],
      operationalResultApis: [decoder.identity],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [valid] }),
    ).not.toThrow();
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [{ ...valid, resultDecoders: [decoder, decoder] }],
      }),
    ).toThrow("Duplicate Result decoder registration");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...valid,
            resultDecoders: [
              {
                ...decoder,
                identity: { module: "stage5-tools.ts", exportName: "decode*" },
              },
            ],
            operationalResultApis: [{ module: "stage5-tools.ts", exportName: "decode*" }],
          },
        ],
      }),
    ).toThrow("must name an exact symbol");
  });

  test("every Result decoder registration owns its exact Zod parser calls", () => {
    const decoder = {
      ...fixtureResultDecoder("registeredDecode"),
      identity: { module: "boundary.ts", exportName: "registeredDecode" },
    };
    const findings = findingsFor("architecture/no-unregistered-decoder", "boundary.ts", {
      resultDecoders: [decoder],
    });
    expect(findings).toHaveLength(1);
  });

  test("recursively rejects unknown in parameters, returns, aliases, properties, generics, maps, unions, and locals", () => {
    const findings = findingsFor("architecture/unknown-free-module", "stage5-render-bad.ts", {
      unknownFreeModules: [{ module: "stage5-render-bad.ts" }],
    });
    const messages = findings.map((finding) => finding.message);
    const identities = findings.map((finding) => finding.identity);
    expect(
      messages.some((message) => message.includes("type alias DirectUnknownAlias")),
    ).toBeTrue();
    expect(
      messages.some((message) => message.includes("type alias NestedUnknownAlias")),
    ).toBeTrue();
    expect(messages.some((message) => message.includes("property payload"))).toBeTrue();
    expect(messages.some((message) => message.includes("parameter value"))).toBeTrue();
    expect(messages.some((message) => message.includes("return type"))).toBeTrue();
    expect(messages.some((message) => message.includes("local local"))).toBeTrue();
    expect(messages.some((message) => message.includes("parameter contract"))).toBeTrue();
    expect(identities.some((identity) => identity.includes("importedMethodOnly"))).toBeTrue();
    expect(identities.some((identity) => identity.includes("importedCallOnly"))).toBeTrue();
    expect(identities.some((identity) => identity.includes("importedNestedMethod"))).toBeTrue();
    expect(identities.some((identity) => identity.includes("importedOverBudget"))).toBeTrue();
    expect(identities.some((identity) => identity.includes("importedRecursive"))).toBeFalse();

    expect(
      findingsFor("architecture/unknown-free-module", "stage5-render-good.ts", {
        unknownFreeModules: [{ module: "stage5-render-good.ts" }],
      }),
    ).toEqual([]);
  });

  test("forbids every decoder registration inside an unknown-free render module", () => {
    const unknownFreeModules = [{ module: "stage5-render-good.ts" }] as const;
    const ruleZones = {
      ...PERMANENT_RULE_ZONES,
      "architecture/unknown-free-module": [{ include: "stage5-render-good.ts" }],
    };
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...BASE_WORKSPACE,
            ruleZones,
            unknownFreeModules,
            boundaryDecoders: [
              {
                identity: { module: "stage5-render-good.ts", exportName: "renderToolProjection" },
                category: "projection",
              },
            ],
          },
        ],
      }),
    ).toThrow("cannot own boundary decoder");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...BASE_WORKSPACE,
            ruleZones: {
              ...ruleZones,
              "architecture/result-decoder-contract": [{ include: "stage5-render-good.ts" }],
            },
            unknownFreeModules,
            resultDecoders: [
              {
                ...fixtureResultDecoder("renderToolProjection"),
                identity: {
                  module: "stage5-render-good.ts",
                  exportName: "renderToolProjection",
                },
              },
            ],
            operationalResultApis: [
              { module: "stage5-render-good.ts", exportName: "renderToolProjection" },
            ],
          },
        ],
      }),
    ).toThrow("cannot own Result decoder");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...BASE_WORKSPACE,
            ruleZones: {
              ...ruleZones,
              "architecture/complete-tool-codec-registry": [{ include: "stage5-render-good.ts" }],
            },
            unknownFreeModules,
            toolCodecRegistries: [
              {
                ...fixtureToolCodecRegistry("renderToolProjection"),
                identity: {
                  module: "stage5-render-good.ts",
                  exportName: "renderToolProjection",
                },
              },
            ],
          },
        ],
      }),
    ).toThrow("cannot own tool codec registry");
  });

  test("keeps ToolProjection switches closed and exhaustive", () => {
    expect(
      findingsFor("architecture/closed-union-exhaustiveness", "stage5-render-good.ts"),
    ).toEqual([]);
    const findings = findingsFor(
      "architecture/closed-union-exhaustiveness",
      "stage5-render-bad.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('"malformed-known-tool"');
  });
});

describe("Stage 6 persistence and SQLite architecture", () => {
  const realRoot = path.join(import.meta.dir, "fixtures/real-libraries");
  const realWorkspaceBase = {
    ...BASE_WORKSPACE,
    name: "real-stage6",
    packageName: "architecture-real-libraries",
    root: "scripts/architecture/fixtures/real-libraries",
    tsconfig: "scripts/architecture/fixtures/real-libraries/tsconfig.json",
  } as const satisfies WorkspaceArchitecture;

  function persistedCodec(
    exportName: string,
    fixtureExportName: string,
    provenance: PersistedCodecRegistration["provenance"] = [
      "current",
      "migrated",
      "missing-defaulted",
    ],
  ): PersistedCodecRegistration {
    return {
      identity: { module: "stage6-persistence.ts", exportName },
      inputParameter: 0,
      fixtureCatalog: { module: "stage6-persistence.ts", exportName: fixtureExportName },
      provenance,
    };
  }

  const transactionAdapter: SqliteTransactionAdapterRegistration = {
    identity: { module: "stage6-transactions.ts", exportName: "runFixtureSqliteTransaction" },
    databaseParameter: 0,
    operationParameter: 1,
    rollbackSentinel: { module: "stage6-transactions.ts", exportName: "FixtureRollback" },
    panicClassifier: { package: "better-result", exportName: "Panic.is" },
    driverErrorClassifier: {
      module: "stage6-transactions.ts",
      exportName: "classifyFixtureSqliteDriverError",
    },
  };

  test("validates real persisted codec contracts, provenance, fixtures, and consumer linkage", () => {
    const codecs = [
      persistedCodec("decodeFixtureStringArray", "fixtureStringArrayCases"),
      persistedCodec("decodeFixtureImportance", "fixtureImportanceCases"),
      persistedCodec("decodeFixtureAboutness", "fixtureAboutnessCases"),
      persistedCodec("decodeFixtureBytes", "fixtureBytesCases"),
      persistedCodec("decodeRequiredFixture", "requiredFixtureCases", ["current", "migrated"]),
    ];
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/persisted-codec-contract": [{ include: "stage6-persistence.ts" }],
        "architecture/persisted-codec-fixture-catalog": [{ include: "stage6-persistence.ts" }],
      },
      persistedCodecs: codecs,
      persistedStoreConsumers: [
        {
          identity: {
            module: "stage6-persistence.ts",
            exportName: "consumeFixturePersistence",
          },
          codecs: [codecs[0]!.identity],
        },
      ],
      operationalResultApis: [
        ...codecs.map(({ identity }) => identity),
        { module: "stage6-persistence.ts", exportName: "consumeFixturePersistence" },
      ],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
    expect(analyzeWorkspace(workspace, realRoot, program)).toEqual([]);
  });

  test("rejects drifted provenance and incomplete or mislabeled fixture catalogs", () => {
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/persisted-codec-contract": [{ include: "stage6-persistence.ts" }],
        "architecture/persisted-codec-fixture-catalog": [{ include: "stage6-persistence.ts" }],
      },
      persistedCodecs: [
        persistedCodec("decodeFixtureWithWrongProvenance", "incompleteFixtureCases"),
      ],
      operationalResultApis: [
        { module: "stage6-persistence.ts", exportName: "decodeFixtureWithWrongProvenance" },
      ],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
    const findings = analyzeWorkspace(workspace, realRoot, program);
    expect(findings.map(({ rule }) => rule).sort()).toEqual([
      "architecture/persisted-codec-contract",
      "architecture/persisted-codec-fixture-catalog",
    ]);
    expect(
      findings.some(({ message }) => message.includes("provenance must be exactly")),
    ).toBeTrue();
    expect(findings.some(({ message }) => message.includes("missing-defaulted"))).toBeTrue();
  });

  test("allows clean-break persisted codecs to reject legacy values explicitly", () => {
    const cleanBreakCodec = {
      ...persistedCodec("decodeRequiredFixture", "requiredFixtureCases", ["current"]),
      legacyOutcome: "rejected" as const,
    };
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        ...PERMANENT_RULE_ZONES,
        "architecture/persisted-codec-contract": [{ include: "stage6-persistence.ts" }],
        "architecture/persisted-codec-fixture-catalog": [{ include: "stage6-persistence.ts" }],
      },
      persistedCodecs: [cleanBreakCodec],
      operationalResultApis: [cleanBreakCodec.identity],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [workspace] }),
    ).not.toThrow();
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...workspace,
            persistedCodecs: [{ ...cleanBreakCodec, provenance: ["current", "migrated"] }],
          },
        ],
      }),
    ).toThrow("cannot declare 'migrated' provenance");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...workspace,
            persistedCodecs: [{ ...cleanBreakCodec, legacyOutcome: undefined }],
          },
        ],
      }),
    ).toThrow("must declare 'migrated' provenance");
  });

  test("fails closed for aliased unregistered persisted consumers and fixture catalogs", () => {
    const codec = persistedCodec("decodeFixtureStringArray", "fixtureStringArrayCases");
    const unregisteredConsumerWorkspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/persisted-codec-contract": [{ include: "stage6-persistence.ts" }],
        "architecture/persisted-codec-fixture-catalog": [{ include: "stage6-persistence.ts" }],
      },
      persistedCodecs: [codec],
      operationalResultApis: [codec.identity],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, unregisteredConsumerWorkspace).program;
    expect(() => analyzeWorkspace(unregisteredConsumerWorkspace, realRoot, program)).toThrow(
      "Unregistered persisted store consumer",
    );

    const unregisteredCatalogWorkspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/persisted-codec-fixture-catalog": [
          { include: "stage6-unregistered-catalog.ts" },
        ],
      },
    } satisfies WorkspaceArchitecture;
    expect(() => analyzeWorkspace(unregisteredCatalogWorkspace, realRoot, program)).toThrow(
      "Unregistered persisted codec fixture catalog",
    );
  });

  test("validates the real bun:sqlite adapter and detects Err returned by a raw callback", () => {
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/sqlite-transaction-adapter-contract": [{ include: "stage6-transactions.ts" }],
        "architecture/no-result-err-in-sqlite-callback": [{ include: "stage6-transactions.ts" }],
        "architecture/no-manual-result-branching": [{ include: "stage6-transactions.ts" }],
      },
      sqliteTransactionAdapters: [transactionAdapter],
      operationalResultApis: [transactionAdapter.identity],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
    const findings = analyzeWorkspace(workspace, realRoot, program);
    expect(
      findings.filter(
        ({ rule, identity }) =>
          rule === "architecture/no-result-err-in-sqlite-callback" &&
          identity.includes("rawDriverCallbackReturningErr"),
      ),
    ).toHaveLength(1);
    expect(
      findings.filter(({ rule }) => rule === "architecture/sqlite-transaction-adapter-contract"),
    ).toEqual([]);
    expect(
      findings.filter(({ rule }) => rule === "architecture/no-manual-result-branching"),
    ).toHaveLength(1);
    expect(
      findings.find(({ rule }) => rule === "architecture/no-manual-result-branching")?.identity,
    ).toContain("inspectAdapterOwnedStatus");
  });

  test("rejects non-private sentinels and inexact Panic or driver classifiers", () => {
    const inexactAdapter = {
      ...transactionAdapter,
      rollbackSentinel: {
        module: "stage6-transactions.ts",
        exportName: "ExportedFixtureRollback",
      },
      panicClassifier: { package: "better-result", exportName: "Panic" },
      driverErrorClassifier: {
        module: "stage6-transactions.ts",
        exportName: "fixtureRowCount",
      },
    } satisfies SqliteTransactionAdapterRegistration;
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/sqlite-transaction-adapter-contract": [{ include: "stage6-transactions.ts" }],
      },
      sqliteTransactionAdapters: [inexactAdapter],
      operationalResultApis: [inexactAdapter.identity],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
    const findings = analyzeWorkspace(workspace, realRoot, program);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("rollback sentinel is exported instead of private");
    expect(findings[0]?.message).toContain("exact Panic classifier");
    expect(findings[0]?.message).toContain("exact SQLite driver classifier");
  });

  test("requires exact captured-cause, thrown Panic, and callback-state SQLite proofs", () => {
    const source = readFileSync(path.join(realRoot, "stage6-transactions.ts"), "utf8");
    const mutations = [
      [
        "const driverFailure = classifyFixtureSqliteDriverError(cause);",
        'const driverFailure = classifyFixtureSqliteDriverError(new Error("unrelated"));',
        "exact SQLite driver classifier",
      ],
      [
        "if (Panic.is(cause)) throw cause;",
        "void Panic.is(cause);\n  if (cause instanceof Panic) throw cause;",
        "exact Panic classifier result",
      ],
      [
        "if (Panic.is(cause)) throw cause;",
        "if (!Panic.is(cause)) throw cause;",
        "exact Panic classifier result",
      ],
      [
        "if (Panic.is(cause)) throw cause;",
        "if (Panic.is(cause) && cause instanceof Error) throw cause;",
        "exact Panic classifier result",
      ],
      [
        "if (Panic.is(cause)) throw cause;",
        "if (Panic.is(cause)) {\n    if (cause instanceof Error) throw cause;\n  }",
        "exact Panic classifier result",
      ],
      [
        "const driverFailure = classifyFixtureSqliteDriverError(cause);",
        "const driverFailure = classifyFixtureSqliteDriverError(Object.assign(cause, { mixed: true }));",
        "exact SQLite driver classifier",
      ],
      [
        "const driverFailure = classifyFixtureSqliteDriverError(cause);\n    if (driverFailure) return Result.err(driverFailure);",
        'void classifyFixtureSqliteDriverError(cause);\n    const driverFailure = new FixtureDriverFailed({ message: "fabricated" });\n    return Result.err(driverFailure);',
        "returned driver Err",
      ],
      [
        "const driverFailure = classifyFixtureSqliteDriverError(cause);\n    if (driverFailure) return Result.err(driverFailure);",
        "const driverFailure = classifyFixtureSqliteDriverError(cause);\n    const copiedDriverFailure = driverFailure;\n    if (driverFailure) return Result.err(copiedDriverFailure);",
        "returned driver Err",
      ],
      [
        "const driverFailure = classifyFixtureSqliteDriverError(cause);\n    if (driverFailure) return Result.err(driverFailure);",
        'let driverFailure = classifyFixtureSqliteDriverError(cause);\n    driverFailure = new FixtureDriverFailed({ message: "overwritten" });\n    if (driverFailure) return Result.err(driverFailure);',
        "returned driver Err",
      ],
      [
        "throw rollbackSentinel;",
        "throw new FixtureRollback(result);",
        "raw driver callback does not throw the rollback sentinel",
      ],
      [
        'throw new Panic({ message: "fixture transaction atomicity is unknown", cause });',
        'void new Panic({ message: "fixture transaction atomicity is unknown", cause });',
        "escalate unknown transaction atomicity",
      ],
      [
        "if (rollbackSentinel !== undefined || callbackCompleted) {",
        "if (cause instanceof Error) {",
        "escalate unknown transaction atomicity",
      ],
    ] as const;

    for (const [before, after, expected] of mutations) {
      const fixtureRoot = mkdtempSync(path.join(realRoot, "sqlite-contract-mutation-"));
      const relativeRoot = path.relative(REPOSITORY_ROOT, fixtureRoot);
      try {
        writeFileSync(
          path.join(fixtureRoot, "tsconfig.json"),
          JSON.stringify({ extends: "../tsconfig.json", include: ["stage6-transactions.ts"] }),
        );
        writeFileSync(
          path.join(fixtureRoot, "stage6-transactions.ts"),
          source.replace(before, after),
        );
        const workspace = {
          ...realWorkspaceBase,
          root: relativeRoot,
          tsconfig: `${relativeRoot}/tsconfig.json`,
          ruleZones: {
            "architecture/sqlite-transaction-adapter-contract": [
              { include: "stage6-transactions.ts" },
            ],
          },
          sqliteTransactionAdapters: [transactionAdapter],
          operationalResultApis: [transactionAdapter.identity],
        } satisfies WorkspaceArchitecture;
        const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
        const findings = analyzeWorkspace(workspace, fixtureRoot, program);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.message).toContain(expected);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("manifest integrity requires exact Panic identity and operational linkage", () => {
    const base = {
      ...realWorkspaceBase,
      ruleZones: {
        ...PERMANENT_RULE_ZONES,
        "architecture/sqlite-transaction-adapter-contract": [{ include: "stage6-transactions.ts" }],
        "architecture/sqlite-transaction-consumer": [{ include: "stage6-transactions.ts" }],
        "architecture/no-result-err-in-sqlite-callback": [{ include: "stage6-transactions.ts" }],
      },
      sqliteTransactionAdapters: [transactionAdapter],
      sqliteTransactionConsumers: [
        {
          identity: {
            module: "stage6-transactions.ts",
            exportName: "goodFixtureTransactionConsumer",
          },
          adapter: transactionAdapter.identity,
        },
      ],
      operationalResultApis: [
        transactionAdapter.identity,
        { module: "stage6-transactions.ts", exportName: "goodFixtureTransactionConsumer" },
      ],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [base] }),
    ).not.toThrow();
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...base,
            sqliteTransactionAdapters: [
              {
                ...transactionAdapter,
                panicClassifier: { package: "better-result", exportName: "Panic" },
              },
            ],
          },
        ],
      }),
    ).toThrow("exact better-result#Panic.is");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [{ ...base, operationalResultApis: [transactionAdapter.identity] }],
      }),
    ).toThrow("must also be listed in operationalResultApis");
  });

  test("requires transaction consumers to call the exact registered adapter", () => {
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/sqlite-transaction-consumer": [{ include: "stage6-transactions.ts" }],
      },
      sqliteTransactionAdapters: [transactionAdapter],
      sqliteTransactionConsumers: [
        {
          identity: {
            module: "stage6-transactions.ts",
            exportName: "goodFixtureTransactionConsumer",
          },
          adapter: transactionAdapter.identity,
        },
        {
          identity: {
            module: "stage6-transactions.ts",
            exportName: "badFixtureTransactionConsumer",
          },
          adapter: transactionAdapter.identity,
        },
      ],
      operationalResultApis: [
        transactionAdapter.identity,
        { module: "stage6-transactions.ts", exportName: "goodFixtureTransactionConsumer" },
        { module: "stage6-transactions.ts", exportName: "badFixtureTransactionConsumer" },
      ],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
    const findings = analyzeWorkspace(workspace, realRoot, program);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("architecture/sqlite-transaction-consumer");
    expect(findings[0]?.identity).toContain("badFixtureTransactionConsumer");
  });

  test("fails closed for an unregistered SQLite transaction consumer", () => {
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/sqlite-transaction-consumer": [{ include: "stage6-transactions.ts" }],
      },
      sqliteTransactionAdapters: [transactionAdapter],
      sqliteTransactionConsumers: [
        {
          identity: {
            module: "stage6-transactions.ts",
            exportName: "badFixtureTransactionConsumer",
          },
          adapter: transactionAdapter.identity,
        },
      ],
      operationalResultApis: [
        transactionAdapter.identity,
        { module: "stage6-transactions.ts", exportName: "badFixtureTransactionConsumer" },
      ],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
    expect(() => analyzeWorkspace(workspace, realRoot, program)).toThrow(
      "Unregistered SQLite transaction consumer",
    );
  });

  test("resolves each call at most once while preflighting persistence targets", () => {
    const checker = fixtureProgram.getTypeChecker();
    const resolutionCounts = new Map<ts.CallExpression, number>();
    const instrumentedChecker = new Proxy(checker, {
      get(target, property, receiver) {
        if (property === "getResolvedSignature") {
          return (...parameters: Parameters<ts.TypeChecker["getResolvedSignature"]>) => {
            const call = parameters[0];
            if (ts.isCallExpression(call)) {
              resolutionCounts.set(call, (resolutionCounts.get(call) ?? 0) + 1);
            }
            return target.getResolvedSignature(...parameters);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const instrumentedProgram = new Proxy(fixtureProgram, {
      get(target, property, receiver) {
        if (property === "getTypeChecker") return () => instrumentedChecker;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      analyzeWorkspace(BASE_WORKSPACE, FIXTURE_ROOT, instrumentedProgram, undefined, undefined, {
        persistedCodecs: [
          {
            packageName: BASE_WORKSPACE.packageName,
            identity: { module: "missing-codec.ts", exportName: "safeParse" },
          },
        ],
        sqliteTransactionAdapters: [
          {
            packageName: BASE_WORKSPACE.packageName,
            identity: { module: "missing-transaction.ts", exportName: "transaction" },
          },
        ],
        scanAllProductionModules: true,
      }),
    ).toEqual([]);
    expect(resolutionCounts.size).toBeGreaterThan(0);
    expect([...resolutionCounts.values()].every((count) => count === 1)).toBeTrue();
  });

  test("executes real better-result codecs and bun:sqlite commit, rollback, driver, and Panic fixtures", async () => {
    const process = Bun.spawn(
      ["bun", "scripts/architecture/fixtures/real-libraries/stage6-runtime.ts"],
      { cwd: REPOSITORY_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});

describe("permanent architecture governance", () => {
  test("keeps active workspaces covered by permanent and exact registration rules", () => {
    expect(architectureManifest.workspaces.map(({ root }) => root).sort()).toEqual(
      ACTIVE_WORKSPACES.map(([root]) => root).sort(),
    );
    for (const workspace of architectureManifest.workspaces) {
      for (const rule of FINAL_PACKAGE_WIDE_ARCHITECTURE_RULES) {
        expect(workspace.ruleZones[rule]).toEqual([{ include: "**" }]);
      }
      for (const rule of EXACT_REGISTRATION_ARCHITECTURE_RULES) {
        expect(
          workspace.ruleZones[rule]?.every(({ include }) => !include.includes("*")),
        ).toBeTrue();
      }
    }
    expect(() => assertArchitectureManifestIntegrity(architectureManifest)).not.toThrow();
  });

  test("retains the canonical event catalog and representative delivery consumers", () => {
    const eventBus = architectureManifest.workspaces.find(
      ({ name }) => name === "packages/event-bus",
    );
    const core = architectureManifest.workspaces.find(({ name }) => name === "apps/core");
    if (!eventBus || !core) throw new Error("Event architecture workspaces missing");

    expect(eventBus.eventCodecRegistries).toContainEqual({
      identity: { module: "lilac-codecs.ts", exportName: "lilacEventCodecRegistry" },
      catalog: { module: "lilac-spec.ts", exportName: "LILAC_EVENTS" },
      catalogHelper: { module: "define-lilac-events.ts", exportName: "defineLilacEvents" },
      registryHelper: {
        module: "define-lilac-events.ts",
        exportName: "createLilacEventCodecRegistry",
      },
    });

    const consumers = new Set(
      core.eventDeliveryConsumers.map(
        ({ identity, operations }) =>
          `${identity.module}#${identity.exportName}:${[...operations].sort().join(",")}`,
      ),
    );
    for (const required of [
      "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner:subscribeTopic",
      "src/workflow/workflow-engine.ts#WorkflowEngine.waitForAgentRequest:fetchTopic,subscribeTopic",
      "src/workflow/workflow-progress-projector.ts#WorkflowProgressProjector.startWorkflowProgressSubscriptionResult:subscribeTopic",
    ]) {
      expect(consumers).toContain(required);
    }
  });

  test("retains representative persisted codec fixture registrations", () => {
    const registrations = new Set(
      architectureManifest.workspaces.flatMap((workspace) =>
        workspace.persistedCodecs.map(
          ({ identity, fixtureCatalog }) =>
            `${workspace.name}:${identity.module}#${identity.exportName}->${fixtureCatalog.module}#${fixtureCatalog.exportName}`,
        ),
      ),
    );

    for (const required of [
      "apps/acp-controller:run-store.ts#decodeRunRecord->run-store.ts#runRecordCodecCases",
      "apps/core:src/migration/frozen-graceful-restart-store.ts#decodeGracefulRestartSnapshot->src/migration/frozen-graceful-restart-store.ts#gracefulRestartSnapshotCodecCases",
      "apps/core:src/workflow/workflow-persistence-codec.ts#decodeWorkflowPersistenceRow->src/workflow/workflow-persistence-codec.ts#workflowPersistenceRowCodecCases",
      "apps/mini-lilac-tui:src/preferences.ts#decodeBindingPreferences->src/preferences.ts#bindingPreferencesCodecCases",
      "packages/mini-lilac-runtime:src/workspace-history-persistence-codec.ts#decodeWorkspaceHistorySnapshotManifest->src/workspace-history-persistence-codec.ts#workspaceHistorySnapshotManifestCodecCases",
      "packages/mini-lilac-runtime:src/sqlite-history-persistence-codec.ts#decodeMiniLilacStructuralHistoryRow->src/sqlite-history-persistence-codec.ts#miniLilacStructuralHistoryRowCodecCases",
      "packages/tool-results:src/tool-result-artifact-metadata-codec.ts#decodeToolResultArtifactMetadata->src/tool-result-artifact-metadata-codec.ts#toolResultArtifactMetadataCodecCases",
      "packages/utils:codex-oauth.ts#decodeCodexTokens->codex-oauth.ts#codexTokensCodecCases",
    ]) {
      expect(registrations).toContain(required);
    }
  });

  test("retains the Mini TUI tool registry and representative boundary decoders", () => {
    const tui = architectureManifest.workspaces.find(({ name }) => name === "apps/mini-lilac-tui");
    if (!tui) throw new Error("Mini TUI architecture workspace missing");

    expect(tui.toolCodecRegistries).toContainEqual({
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
    });

    const decoders = new Set(
      architectureManifest.workspaces.flatMap((workspace) =>
        workspace.boundaryDecoders.map(
          ({ identity, category }) =>
            `${workspace.name}:${identity.module}#${identity.exportName}:${category}`,
        ),
      ),
    );
    for (const required of [
      "apps/core:src/tool-server/create-tool-server.ts#normalizeSuccessfulToolValue:plugin",
      "apps/core:src/surface/bridge/bus-agent-runner/raw.ts#parseRequestControlFromRaw:projection",
      "apps/core:src/workflow/workflow-action-resolver.ts#decodeWorkflowActionOutboxEvent:persistence",
      "apps/tool-bridge:client.ts#projectBridgeFailure:wire",
      "apps/mini-lilac-server:src/server.ts#decodeMiniLilacHttpRequest:request",
      "packages/fs:src/remote-runner-protocol.ts#decodeJson:wire",
      "packages/plugin-runtime:server-tool-result.ts#decodeServerToolResult:plugin",
      "packages/plugin-runtime:server-tool-result.ts#transform.<callback@1>@2:plugin",
      "packages/utils:custom-commands.ts#decodeCustomCommandResult:plugin",
    ]) {
      expect(decoders).toContain(required);
    }
  });

  test("retains critical exact exception registrations and approvals", () => {
    const registrations = new Set(
      architectureManifest.workspaces.flatMap((workspace) =>
        workspace.exceptionAdapters.map(
          ({ identity, category, externalApi, direction }) =>
            `${workspace.name}:${identity.module}#${identity.exportName}:${category}:${externalApi.package}#${externalApi.exportName}:${direction}`,
        ),
      ),
    );
    const approvals = new Set(
      architectureManifest.approvedExceptionAdapters.map(
        ({ workspace, callable, category, externalApi, mode }) =>
          `${workspace}:${callable.module}#${callable.exportName}:${category}:${externalApi.package}#${externalApi.exportName}:${mode}`,
      ),
    );
    const required = [
      "apps/core:src/surface/bridge/adapter-event-projection.ts#signalAdapterEventPlatformMismatch:defect-supervisor:better-result#Panic:signal-host",
      "apps/core:src/surface/produced-ref-guard.ts#signalSurfaceAdapterContractViolation:defect-supervisor:better-result#Panic:signal-host",
    ];

    for (const identity of required) {
      expect(registrations).toContain(identity);
      expect(approvals).toContain(identity);
    }

    for (const stale of [
      "apps/core:src/tool-server/tools/mcp.ts#resultToMcpToolValue.err.<callback>",
      "apps/core:src/tool-server/tools/attachment.ts#adaptAttachmentResultToToolHost.err.<callback>",
      "apps/core:src/tool-server/tools/programmatic-workflow.ts#adaptWorkflowToolResultToHost.err.<callback>",
      "apps/core:src/tool-server/create-tool-server.ts#isToolInputValidationCause",
      "packages/plugin-runtime:define-server-tool.ts#adaptServerToolDispatchResultToHost",
    ]) {
      expect([...registrations].some((registration) => registration.startsWith(stale))).toBeFalse();
      expect([...approvals].some((approval) => approval.startsWith(stale))).toBeFalse();
    }
  });

  test("retains Level-2 operational Result boundaries", () => {
    const registrations = new Set(
      architectureManifest.workspaces.flatMap((workspace) =>
        workspace.operationalResultApis.map(
          ({ module, exportName }) => `${workspace.name}:${module}#${exportName}`,
        ),
      ),
    );

    for (const required of [
      "packages/plugin-runtime:types.ts#ServerTool.call",
      "apps/core:src/tool-server/create-tool-server.ts#normalizeSuccessfulToolValue",
      "packages/plugin-runtime:server-tool-result.ts#decodeServerToolResult",
      "packages/plugin-runtime:define-server-tool.ts#createCallable.<callback>.invoke",
      "packages/plugin-runtime:define-server-tool.ts#lookupServerToolCallable",
      "packages/plugin-runtime:define-server-tool.ts#defineServerTool.call",
      "packages/plugin-runtime:hooks.ts#invokeLevel2Call",
      "apps/core:src/tool-server/tools/attachment.ts#Attachment.call",
      "apps/core:src/tool-server/tools/codex.ts#Codex.call",
      "apps/core:src/tool-server/tools/content-inspect.ts#ContentInspect.call",
      "apps/core:src/tool-server/tools/conversation-thread.ts#ConversationThread.call",
      "apps/core:src/tool-server/tools/discovery.ts#Discovery.call",
      "apps/core:src/tool-server/tools/generate.ts#Generate.call",
      "apps/core:src/tool-server/tools/mcp.ts#McpManagement.call",
      "apps/core:src/tool-server/tools/onboarding.ts#Onboarding.call",
      "apps/core:src/tool-server/tools/programmatic-workflow.ts#ProgrammaticWorkflow.call",
      "apps/core:src/tool-server/tools/skills.ts#Skills.call",
      "apps/core:src/tool-server/tools/ssh.ts#SSH.call",
      "apps/core:src/tool-server/tools/surface.ts#Surface.call",
      "apps/core:src/tool-server/tools/web.ts#Web.call",
    ]) {
      expect(registrations).toContain(required);
    }

    const core = architectureManifest.workspaces.find(({ name }) => name === "apps/core");
    expect(core?.compatibilityOutputs).toContainEqual({
      sink: {
        kind: "local",
        module: "src/tool-server/create-tool-server.ts",
        exportName: "createToolServer.post.<callback@2>@2",
      },
      category: "http",
      reason: "Projects Level-2 Results to the established strict Core tool-server wire envelope.",
    });
  });

  test("rejects missing and broad exact-registration zones", () => {
    const decoder = fixtureResultDecoder("decodeKnownToolObservation");
    const workspace = {
      ...BASE_WORKSPACE,
      ruleZones: PERMANENT_RULE_ZONES,
      resultDecoders: [decoder],
      operationalResultApis: [decoder.identity],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [workspace] }),
    ).toThrow("exact architecture/result-decoder-contract zones must equal registered modules");

    const broad = {
      ...workspace,
      ruleZones: {
        ...workspace.ruleZones,
        "architecture/result-decoder-contract": [{ include: "**" }],
      },
    } satisfies WorkspaceArchitecture;
    expect(() => assertArchitectureManifestIntegrity({ version: 1, workspaces: [broad] })).toThrow(
      "Remove broad or stale zones",
    );

    const exact = {
      ...workspace,
      ruleZones: {
        ...workspace.ruleZones,
        "architecture/result-decoder-contract": [{ include: decoder.identity.module }],
      },
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [exact] }),
    ).not.toThrow();
  });

  test("requires registered Result boundaries in the operational catalog", () => {
    const decoder = fixtureResultDecoder("decodeKnownToolObservation");
    const workspace = {
      ...BASE_WORKSPACE,
      ruleZones: {
        ...PERMANENT_RULE_ZONES,
        "architecture/result-decoder-contract": [{ include: decoder.identity.module }],
      },
      resultDecoders: [decoder],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [workspace] }),
    ).toThrow("must also be listed in operationalResultApis");
  });

  test("rejects stale operational Result identities", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      operationalResultApis: [{ module: "result.ts", exportName: "missingResultApi" }],
    } satisfies WorkspaceArchitecture;
    expect(() => analyzeWorkspace(workspace, FIXTURE_ROOT, fixtureProgram)).toThrow(
      "must resolve to exactly one callable implementation; found 0",
    );
  });
});

describe("real declaration integration", () => {
  test("rejects manual Result branch discrimination through real better-result declarations and aliases", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      name: "real-libraries-manual-result-branching",
      packageName: "architecture-real-libraries",
      root: "scripts/architecture/fixtures/real-libraries",
      tsconfig: "scripts/architecture/fixtures/real-libraries/tsconfig.json",
      ruleZones: {
        "architecture/no-manual-result-branching": [
          { include: "manual-result-branching-invalid.ts" },
        ],
      },
    } satisfies WorkspaceArchitecture;
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, workspace);
    const findings = analyzeWorkspace(workspace, workspaceProgram.root, workspaceProgram.program);

    expect(findings).toHaveLength(22);
    expect(findings.map((finding) => finding.location?.line)).toEqual([
      14, 18, 22, 26, 32, 37, 38, 42, 43, 47, 48, 52, 52, 58, 58, 58, 66, 70, 74, 81, 98, 102,
    ]);
  });

  test("permits structural domain statuses, serialized envelopes, and Result composition", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      name: "real-libraries-valid-result-composition",
      packageName: "architecture-real-libraries",
      root: "scripts/architecture/fixtures/real-libraries",
      tsconfig: "scripts/architecture/fixtures/real-libraries/tsconfig.json",
      ruleZones: {
        "architecture/no-manual-result-branching": [
          { include: "manual-result-branching-valid.ts" },
        ],
      },
    } satisfies WorkspaceArchitecture;
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, workspace);

    expect(analyzeWorkspace(workspace, workspaceProgram.root, workspaceProgram.program)).toEqual(
      [],
    );
  });

  test("permits positive isErr guards only for direct local object-form captures", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      name: "real-libraries-result-capture-settlement",
      packageName: "architecture-real-libraries",
      root: "scripts/architecture/fixtures/real-libraries",
      tsconfig: "scripts/architecture/fixtures/real-libraries/tsconfig.json",
      ruleZones: {
        "architecture/no-manual-result-branching": [
          { include: "manual-result-capture-settlement-valid.ts" },
        ],
      },
    } satisfies WorkspaceArchitecture;
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, workspace);

    expect(analyzeWorkspace(workspace, workspaceProgram.root, workspaceProgram.program)).toEqual(
      [],
    );
  });

  test("rejects other guards and non-local or non-object-form capture provenance", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      name: "real-libraries-invalid-result-capture-settlement",
      packageName: "architecture-real-libraries",
      root: "scripts/architecture/fixtures/real-libraries",
      tsconfig: "scripts/architecture/fixtures/real-libraries/tsconfig.json",
      ruleZones: {
        "architecture/no-manual-result-branching": [
          { include: "manual-result-capture-settlement-invalid.ts" },
        ],
      },
    } satisfies WorkspaceArchitecture;
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, workspace);
    const findings = analyzeWorkspace(workspace, workspaceProgram.root, workspaceProgram.program);

    expect(findings).toHaveLength(9);
    expect(findings.every(({ rule }) => rule === "architecture/no-manual-result-branching")).toBe(
      true,
    );
  });

  test("recognizes real installed zod and better-result 3.0 declarations", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      name: "real-libraries",
      packageName: "architecture-real-libraries",
      root: "scripts/architecture/fixtures/real-libraries",
      tsconfig: "scripts/architecture/fixtures/real-libraries/tsconfig.json",
      ruleZones: Object.fromEntries(
        [
          "architecture/no-unregistered-decoder",
          "architecture/no-production-unwrap",
          "architecture/no-unmapped-result-capture",
        ].map((rule) => [rule, [{ include: "fixture.ts" }]]),
      ),
    } satisfies WorkspaceArchitecture;
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, workspace);
    const findings = analyzeWorkspace(workspace, workspaceProgram.root, workspaceProgram.program);
    expect(
      findings.filter((finding) => finding.rule === "architecture/no-unregistered-decoder"),
    ).toHaveLength(1);
    expect(
      findings.filter((finding) => finding.rule === "architecture/no-production-unwrap"),
    ).toHaveLength(3);
    expect(
      findings.filter((finding) => finding.rule === "architecture/no-unmapped-result-capture"),
    ).toHaveLength(1);
  });

  test("recursively rejects unknown error payloads through real better-result declarations", () => {
    const resultDecoder = (exportName: string): ResultDecoderRegistration => ({
      identity: { module: "fixture.ts", exportName },
      category: "projection",
      inputParameter: 0,
    });
    const workspace = {
      ...BASE_WORKSPACE,
      name: "real-libraries-result-decoder",
      packageName: "architecture-real-libraries",
      root: "scripts/architecture/fixtures/real-libraries",
      tsconfig: "scripts/architecture/fixtures/real-libraries/tsconfig.json",
      ruleZones: {
        "architecture/result-decoder-contract": [{ include: "fixture.ts" }],
      },
      resultDecoders: [
        resultDecoder("decodeRealResult"),
        resultDecoder("decodeRealResultWithUnknownCause"),
      ],
    } satisfies WorkspaceArchitecture;
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, workspace);
    const findings = analyzeWorkspace(workspace, workspaceProgram.root, workspaceProgram.program);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.identity).toContain("decodeRealResultWithUnknownCause");
    expect(findings[0]?.message).toContain("Result error type is not specific");
  });

  test("enforces Stage 1 contracts and TaggedError redaction against real better-result declarations", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      name: "real-libraries-stage1",
      packageName: "architecture-real-libraries",
      root: "scripts/architecture/fixtures/real-libraries",
      tsconfig: "scripts/architecture/fixtures/real-libraries/tsconfig.json",
      ruleZones: Object.fromEntries(
        [
          "architecture/no-unhandled-exception-contract",
          "architecture/no-unredacted-tagged-error-log",
          "architecture/fallible-api-result",
          "architecture/no-result-wire-leak",
        ].map((rule) => [rule, [{ include: "stage1.ts" }]]),
      ),
      structuredLoggers: [
        {
          sink: { kind: "local", module: "stage1.ts", exportName: "structuredLog" },
          reason: "Fixture logger accepts arbitrary structured fields.",
        },
        {
          sink: {
            kind: "external",
            package: "@stanley2058/simple-module-logger",
            exportName: "error",
          },
          reason: "Real logger accepts arbitrary structured fields.",
        },
      ],
      taggedErrorFormatters: [
        {
          kind: "external",
          package: "@stanley2058/lilac-utils",
          exportName: "formatTaggedErrorForLog",
        },
      ],
      operationalResultApis: [
        { module: "stage1.ts", exportName: "rejectingFallibleApi" },
        { module: "stage1.ts", exportName: "resultFallibleApi" },
        { module: "stage1.ts", exportName: "directResultFallibleApi" },
        { module: "stage1.ts", exportName: "resultFallibleStream" },
        { module: "stage1.ts", exportName: "inferredResultFallibleStream" },
        { module: "stage1.ts", exportName: "wrongResultFallibleStream" },
      ],
    } satisfies WorkspaceArchitecture;
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, workspace);
    const findings = analyzeWorkspace(workspace, workspaceProgram.root, workspaceProgram.program, [
      { packageName: workspace.packageName, root: workspaceProgram.root },
      {
        packageName: "@stanley2058/lilac-utils",
        root: path.join(REPOSITORY_ROOT, "packages/utils"),
      },
    ]);

    expect(
      findings.filter((finding) => finding.rule === "architecture/no-unhandled-exception-contract"),
    ).toHaveLength(9);
    const unhandledMessages = findings
      .filter((finding) => finding.rule === "architecture/no-unhandled-exception-contract")
      .map((finding) => finding.message);
    const unhandledIdentities = findings
      .filter((finding) => finding.rule === "architecture/no-unhandled-exception-contract")
      .map((finding) => finding.identity);
    expect(new Set(unhandledIdentities).size).toBe(9);
    expect(unhandledMessages.some((message) => message.includes("Panic or unknown"))).toBeTrue();
    expect(
      unhandledMessages.some((message) => message.includes("UnhandledService.load")),
    ).toBeTrue();
    expect(
      unhandledMessages.some((message) => message.includes("UnhandledCallableService.<call>")),
    ).toBeTrue();
    expect(
      unhandledMessages.some((message) => message.includes("UnhandledHandler.<call>")),
    ).toBeTrue();
    expect(
      unhandledMessages.some((message) => message.includes("laterExportedContract")),
    ).toBeTrue();
    const redactionFindings = findings.filter(
      (finding) => finding.rule === "architecture/no-unredacted-tagged-error-log",
    );
    expect(redactionFindings).toHaveLength(13);
    expect(
      redactionFindings.filter((finding) =>
        finding.identity.includes("destructureTaggedErrorMessage"),
      ),
    ).toHaveLength(2);
    expect(
      redactionFindings.filter((finding) => finding.identity.includes("assignTaggedErrorMessage")),
    ).toHaveLength(2);
    expect(
      redactionFindings.some((finding) => finding.message.includes("JSON.stringify")),
    ).toBeTrue();
    expect(redactionFindings.some((finding) => finding.message.includes("toJSON"))).toBeTrue();
    expect(
      redactionFindings.some((finding) => finding.message.includes("structured logger")),
    ).toBeTrue();
    expect(
      redactionFindings.every((finding) => finding.suggestion.includes("redacting")),
    ).toBeTrue();
    const fallibleFindings = findings.filter(
      (finding) => finding.rule === "architecture/fallible-api-result",
    );
    expect(fallibleFindings).toHaveLength(2);
    expect(fallibleFindings[0]?.message).toContain("rejectingFallibleApi");
    expect(
      fallibleFindings.some((finding) => finding.message.includes("wrongResultFallibleStream")),
    ).toBeTrue();
    expect(
      fallibleFindings.every((finding) => finding.suggestion.includes("Promise<Result<T, E>>")),
    ).toBeTrue();
    const resultLeaks = findings.filter(
      (finding) => finding.rule === "architecture/no-result-wire-leak",
    );
    expect(resultLeaks).toHaveLength(2);
    expect(resultLeaks.every((finding) => finding.message.includes("JSON.stringify"))).toBeTrue();
  });

  test("resolves Bun-realpathed cross-workspace declarations to package identities", () => {
    const core = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/core",
    );
    if (!core) throw new Error("core workspace missing");
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, core);
    const sourceFile = workspaceProgram.program.getSourceFile(
      path.join(workspaceProgram.root, "src/mcp/value-source.ts"),
    );
    if (!sourceFile) throw new Error("core integration source missing");
    let declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined;
    const checker = workspaceProgram.program.getTypeChecker();
    const visit = (node: ts.Node): void => {
      if (
        !declaration &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "isRecord"
      ) {
        declaration = checker.getResolvedSignature(node)?.declaration;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const packageRoots = architectureManifest.workspaces.map((workspace) => ({
      packageName: workspace.packageName,
      root: path.join(REPOSITORY_ROOT, workspace.root),
    }));
    expect(declarationPackageName(declaration, packageRoots)).toBe("@stanley2058/lilac-utils");
  }, 30_000);

  test("fails closed when a production module cannot be resolved", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      name: "diagnostics",
      packageName: "architecture-diagnostics",
      root: "scripts/architecture/fixtures/diagnostics",
      tsconfig: "scripts/architecture/fixtures/diagnostics/tsconfig.json",
      compatibilityOutputs: [
        {
          sink: {
            kind: "external",
            package: "architecture-fixture-missing-module",
            exportName: "missing",
          },
          category: "worker",
          reason: "Exercises targeted resolution validation for a registered sink.",
        },
      ],
    } satisfies WorkspaceArchitecture;
    expect(() => createWorkspaceProgram(REPOSITORY_ROOT, workspace)).toThrow(
      "TS6 cannot safely analyze diagnostics",
    );
  });

  test("does not request unrelated semantic diagnostics", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      name: "semantic-diagnostics",
      packageName: "architecture-semantic-diagnostics",
      root: "scripts/architecture/fixtures/diagnostics",
      tsconfig: "scripts/architecture/fixtures/diagnostics/semantic-tsconfig.json",
    } satisfies WorkspaceArchitecture;
    expect(() => createWorkspaceProgram(REPOSITORY_ROOT, workspace)).not.toThrow();
  });
});

describe("architecture Program construction", () => {
  test("checks production fixture modules while excluding test-owned fixture modules", () => {
    withProgramFixture(
      {
        "src/fixtures/runtime.ts":
          "export function project(value: unknown) { return value as { id: string }; }\n",
        "tests/fixtures/support.ts":
          "export function project(value: unknown) { return value as { id: string }; }\n",
      },
      ({ repositoryRoot, workspaceRoot, workspace }) => {
        const program = createWorkspaceProgram(repositoryRoot, workspace).program;
        const findings = analyzeWorkspace(
          {
            ...workspace,
            ruleZones: { "architecture/no-unknown-assertion": [{ include: "**" }] },
          },
          workspaceRoot,
          program,
        );
        expect(findings.map(({ rule, location }) => ({ rule, file: location?.file }))).toEqual([
          { rule: "architecture/no-unknown-assertion", file: "src/fixtures/runtime.ts" },
        ]);
      },
    );
  });

  test("filters non-production roots, retains declarations, and resolves imported dependencies", () => {
    withProgramFixture(
      {
        "src/index.ts":
          'import { decodeFixture } from "../tests/support.ts";\nexport const value = decodeFixture("value");\n',
        "tests/support.ts": "export function decodeFixture(value: unknown) { return value; }\n",
        "tests/root-only.ts": "export const rootOnly = true;\n",
        "tests/contracts.d.ts": "declare const fixtureContract: unique symbol;\n",
        "dist/generated.ts": "export const generated = true;\n",
      },
      ({ repositoryRoot, workspaceRoot, workspace }) => {
        const program = createWorkspaceProgram(repositoryRoot, workspace).program;
        const relativeRoots = program
          .getRootFileNames()
          .map((fileName) => path.relative(workspaceRoot, fileName).split(path.sep).join("/"))
          .sort();
        expect(relativeRoots).toEqual(["src/index.ts", "tests/contracts.d.ts"]);
        expect(program.getSourceFile(path.join(workspaceRoot, "tests/support.ts"))).toBeDefined();
        expect(
          program.getSourceFile(path.join(workspaceRoot, "tests/root-only.ts")),
        ).toBeUndefined();

        const nonProductionRegistration = {
          ...workspace,
          ruleZones: {
            "architecture/persisted-codec-contract": [{ include: "tests/support.ts" }],
          },
          persistedCodecs: [
            {
              identity: { module: "tests/support.ts", exportName: "decodeFixture" },
              inputParameter: 0,
              fixtureCatalog: { module: "tests/support.ts", exportName: "fixtureCodecCases" },
              provenance: ["current", "migrated", "missing-defaulted"],
            },
          ],
        } satisfies WorkspaceArchitecture;
        expect(() => analyzeWorkspace(nonProductionRegistration, workspaceRoot, program)).toThrow(
          "must resolve to exactly one declaration; found 0",
        );

        const nonProductionOpenProtocol = {
          ...workspace,
          openProtocolAdapters: [
            openProtocolAdapter("decodeFixture", {
              identity: { module: "tests/support.ts", exportName: "decodeFixture" },
            }),
          ],
        } satisfies WorkspaceArchitecture;
        expect(() => analyzeWorkspace(nonProductionOpenProtocol, workspaceRoot, program)).toThrow(
          "must resolve to exactly one callable implementation; found 0",
        );

        const nonProductionOperationalApi = {
          ...workspace,
          operationalResultApis: [{ module: "tests/support.ts", exportName: "decodeFixture" }],
        } satisfies WorkspaceArchitecture;
        expect(() => analyzeWorkspace(nonProductionOperationalApi, workspaceRoot, program)).toThrow(
          "must resolve to exactly one callable implementation; found 0",
        );

        const nonProductionUnknownFreeModule = {
          ...workspace,
          ruleZones: {
            "architecture/unknown-free-module": [{ include: "tests/support.ts" }],
          },
          unknownFreeModules: [{ module: "tests/support.ts" }],
        } satisfies WorkspaceArchitecture;
        expect(() =>
          analyzeWorkspace(nonProductionUnknownFreeModule, workspaceRoot, program),
        ).toThrow("must resolve to exactly one source module; found 0");
      },
    );
  });

  test("requests blocking syntactic diagnostics only for production sources", () => {
    withProgramFixture(
      {
        "src/index.ts": 'import "../tests/broken.ts";\nexport const valid = true;\n',
        "tests/broken.ts": "export const broken = ;\n",
      },
      ({ repositoryRoot, workspace }) => {
        expect(() => createWorkspaceProgram(repositoryRoot, workspace)).not.toThrow();
      },
    );
    withProgramFixture(
      { "src/broken.ts": "export const broken = ;\n" },
      ({ repositoryRoot, workspace }) => {
        expect(() => createWorkspaceProgram(repositoryRoot, workspace)).toThrow(
          "TS6 cannot safely analyze program-fixture",
        );
      },
    );
    withProgramFixture(
      { "src/contracts.d.ts": "export declare const broken: ;\n" },
      ({ repositoryRoot, workspace }) => {
        expect(() => createWorkspaceProgram(repositoryRoot, workspace)).toThrow(
          "TS6 cannot safely analyze program-fixture",
        );
      },
    );
  });
});

describe("gate infrastructure", () => {
  test("requires the manifest to exactly match discovered Bun workspaces", () => {
    expect(
      compareWorkspaceInventory(
        ["apps/core", "packages/utils", "packages/new-workspace"],
        ["apps/core", "apps/removed-workspace", "packages/utils", "packages/utils"],
      ),
    ).toEqual({
      duplicateManifestRoots: ["packages/utils"],
      missingManifestRoots: ["apps/removed-workspace"],
      unmanifestedRoots: ["packages/new-workspace"],
    });
    expect(
      compareWorkspaceInventory(["apps/core", "packages/utils"], ["packages/utils", "apps/core"]),
    ).toEqual({
      duplicateManifestRoots: [],
      missingManifestRoots: [],
      unmanifestedRoots: [],
    });
    expect(() =>
      assertWorkspaceInventoryMatches(
        ["apps/core", "packages/new-workspace"],
        ["apps/core", "apps/removed-workspace"],
      ),
    ).toThrow(
      "Unmanifested Bun workspaces: packages/new-workspace. Add them to scripts/architecture/manifest.ts before scanning.",
    );
  });

  test("fingerprints tolerate line movement and unrelated surrounding edits", () => {
    const sourceA = ts.createSourceFile(
      "a.ts",
      "const value = input as { id: string };",
      ts.ScriptTarget.Latest,
      true,
    );
    const sourceB = ts.createSourceFile(
      "a.ts",
      "const unrelated = 1;\n\n\nconst value = input as { id: string };",
      ts.ScriptTarget.Latest,
      true,
    );
    const assertion = (source: ts.SourceFile): ts.AsExpression => {
      let found: ts.AsExpression | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isAsExpression(node)) found = node;
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!found) throw new Error("fixture assertion missing");
      return found;
    };
    const input = {
      workspace: "fixture",
      rule: "architecture/no-unknown-assertion" as const,
      module: "a.ts",
      symbolPath: "decode",
    };
    expect(createFingerprint({ ...input, node: assertion(sourceA) })).toBe(
      createFingerprint({ ...input, node: assertion(sourceB) }),
    );
  });

  test("fingerprints separate same-named symbols across modules and classes", () => {
    const source = ts.createSourceFile(
      "same.ts",
      "class Left { decode() { return input as { id: string }; } } class Right { decode() { return input as { id: string }; } }",
      ts.ScriptTarget.Latest,
      true,
    );
    const assertions: ts.AsExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node)) assertions.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const left = assertions[0];
    const right = assertions[1];
    if (!left || !right) throw new Error("class assertion fixtures missing");
    const common = {
      workspace: "fixture",
      rule: "architecture/no-unknown-assertion" as const,
      module: "same.ts",
    };
    expect(createFingerprint({ ...common, symbolPath: "Left.decode", node: left })).not.toBe(
      createFingerprint({ ...common, symbolPath: "Right.decode", node: right }),
    );
    expect(
      createFingerprint({ ...common, module: "other.ts", symbolPath: "Left.decode", node: left }),
    ).not.toBe(createFingerprint({ ...common, symbolPath: "Left.decode", node: left }));
  });

  test("creates exactly one Program per active workspace", () => {
    const manifest = {
      version: 1,
      workspaces: [
        { ...BASE_WORKSPACE, name: "fixture-a", ruleZones: PERMANENT_RULE_ZONES },
        { ...BASE_WORKSPACE, name: "fixture-b", ruleZones: PERMANENT_RULE_ZONES },
      ],
    } satisfies ArchitectureManifest;
    let programs = 0;
    analyzeArchitecture(REPOSITORY_ROOT, manifest, (_root, _workspace) => {
      programs += 1;
      return { root: FIXTURE_ROOT, program: fixtureProgram };
    });
    expect(programs).toBe(2);
  });

  test("preserves diagnostics when analysis is partitioned by workspace", () => {
    const manifest = {
      version: 1,
      workspaces: [
        { ...BASE_WORKSPACE, name: "fixture-a", ruleZones: PERMANENT_RULE_ZONES },
        { ...BASE_WORKSPACE, name: "fixture-b", ruleZones: PERMANENT_RULE_ZONES },
      ],
    } satisfies ArchitectureManifest;
    const programFactory: typeof createWorkspaceProgram = (_root, _workspace) => ({
      root: FIXTURE_ROOT,
      program: fixtureProgram,
    });
    const context = createArchitectureAnalysisContext(REPOSITORY_ROOT, manifest);
    const partitioned = manifest.workspaces.flatMap((workspace) =>
      analyzeArchitectureWorkspace(REPOSITORY_ROOT, workspace, context, programFactory),
    );
    const direct = manifest.workspaces.flatMap((workspace) =>
      analyzeWorkspace(
        workspace,
        FIXTURE_ROOT,
        fixtureProgram,
        context.packageRoots,
        context.activeEventDeliveryApiPackages,
        context.activePersistenceInfrastructure,
        context.approvedExceptionAdapters,
      ),
    );

    expect([...partitioned]).toEqual([...direct]);
  });

  test("reuses cached workspace diagnostics without reentering the TypeChecker", () => {
    const cacheRoot = mkdtempSync(path.join(tmpdir(), "lilac-architecture-cache-test-"));
    try {
      const cache = new WorkspaceAnalysisCache(REPOSITORY_ROOT, cacheRoot);
      const context = createArchitectureAnalysisContext(REPOSITORY_ROOT, {
        ...architectureManifest,
        workspaces: [BASE_WORKSPACE],
      });
      const programFactory = () => ({ root: FIXTURE_ROOT, program: fixtureProgram });
      const expected = analyzeArchitectureWorkspace(
        REPOSITORY_ROOT,
        BASE_WORKSPACE,
        context,
        programFactory,
        cache,
      );
      const cachedProgram = new Proxy(fixtureProgram, {
        get(target, property, receiver) {
          if (property === "getTypeChecker") {
            return () => {
              throw new Error("cached analysis reentered the TypeChecker");
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });

      expect(
        analyzeArchitectureWorkspace(
          REPOSITORY_ROOT,
          BASE_WORKSPACE,
          context,
          () => ({ root: FIXTURE_ROOT, program: cachedProgram }),
          cache,
        ),
      ).toEqual(expected);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("invalidates cached workspace diagnostics when a loaded source changes", () => {
    withProgramFixture(
      { "input.ts": "export const value = 1;" },
      ({ repositoryRoot, workspace }) => {
        const context = createArchitectureAnalysisContext(repositoryRoot, {
          ...architectureManifest,
          workspaces: [workspace],
        });
        const first = createCachingWorkspaceProgramFactory()(repositoryRoot, workspace).program;
        const firstKey = workspaceAnalysisCacheKey(repositoryRoot, workspace, first, context);
        writeFileSync(path.join(repositoryRoot, "workspace/input.ts"), "export const value = 2;");
        const second = createCachingWorkspaceProgramFactory()(repositoryRoot, workspace).program;
        const secondKey = workspaceAnalysisCacheKey(repositoryRoot, workspace, second, context);

        expect(secondKey).not.toBe(firstKey);
      },
    );
  });

  test("real workspace subprocess exits cleanly without writing output", async () => {
    const result = await runFixtureWorkspaceProcess(`${WORKSPACE_RUNNER_FIXTURE_ROOT}/clean`);

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("real workspace subprocess writes ordered structured diagnostics and exits 42", async () => {
    const result = await runFixtureWorkspaceProcess(`${WORKSPACE_RUNNER_FIXTURE_ROOT}/findings`);

    expect(result.exitCode).toBe(ARCHITECTURE_FINDINGS_EXIT_CODE);
    expect(result.stdout).toBe("");
    const diagnostics = result.stderr.trimEnd().split("\n");
    const identities = diagnostics.map((diagnostic) => {
      expect(diagnostic).toMatch(
        /^fixture-findings\/fixture\.ts:\d+:\d+ error architecture\/no-unknown-assertion: /,
      );
      const fingerprint = diagnostic.match(
        /\[arch-v2\|workspace=([^|]+)\|rule=([^|]+)\|identity=([^|]+)\|sha256=([0-9a-f]{64})\]$/,
      );
      expect(fingerprint).not.toBeNull();
      expect(fingerprint?.[1]).toBe("fixture-findings");
      expect(decodeURIComponent(fingerprint?.[2] ?? "")).toBe("architecture/no-unknown-assertion");
      return decodeURIComponent(fingerprint?.[3] ?? "");
    });
    expect(identities).toEqual([
      "fixture.ts#firstProjection[AsExpression]@1",
      "fixture.ts#secondProjection[AsExpression]@1",
    ]);
  });

  test("real workspace subprocess reports manual Result branching", async () => {
    const result = await runFixtureWorkspaceProcess(
      `${WORKSPACE_RUNNER_FIXTURE_ROOT}/manual-result`,
    );

    expect(result.exitCode).toBe(ARCHITECTURE_FINDINGS_EXIT_CODE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /^fixture-manual-result\/fixture\.ts:\d+:\d+ error architecture\/no-manual-result-branching: /,
    );
    expect(result.stderr).toContain("reconstructs both Result branch envelopes");
  });

  test("maps a real workspace subprocess error to fail-closed parent behavior", async () => {
    const cleanRoot = `${WORKSPACE_RUNNER_FIXTURE_ROOT}/clean`;
    const missingRoot = `${WORKSPACE_RUNNER_FIXTURE_ROOT}/missing`;
    const unvisitedRoot = `${WORKSPACE_RUNNER_FIXTURE_ROOT}/findings`;
    const manifest = {
      version: 1,
      workspaces: [
        {
          ...BASE_WORKSPACE,
          name: "fixture-clean",
          root: cleanRoot,
          ruleZones: PERMANENT_RULE_ZONES,
        },
        {
          ...BASE_WORKSPACE,
          name: "fixture-missing",
          root: missingRoot,
          ruleZones: PERMANENT_RULE_ZONES,
        },
        {
          ...BASE_WORKSPACE,
          name: "fixture-unvisited",
          root: unvisitedRoot,
          ruleZones: PERMANENT_RULE_ZONES,
        },
      ],
    } satisfies ArchitectureManifest;
    const observed: (WorkspaceRunnerResult & { readonly workspaceRoot: string })[] = [];

    await expect(
      analyzeArchitectureInWorkspaceProcesses(
        REPOSITORY_ROOT,
        manifest,
        async (_root, workspaceRoot) => {
          const result = await runFixtureWorkspaceProcess(workspaceRoot);
          observed.push({ workspaceRoot, ...result });
          return result;
        },
        { writeStdout() {}, writeStderr() {} },
      ),
    ).rejects.toThrow(
      "Architecture analysis subprocess for fixture-missing failed with exit code 1",
    );
    expect(observed.map(({ workspaceRoot }) => workspaceRoot)).toEqual([cleanRoot, missingRoot]);
    expect(observed[0]).toEqual({ workspaceRoot: cleanRoot, exitCode: 0, stdout: "", stderr: "" });
    expect(observed[1]?.exitCode).toBe(1);
    expect(observed[1]?.stdout).toBe("");
    expect(observed[1]?.stderr).toContain(`Unknown architecture workspace '${missingRoot}'.`);
  });

  test("defaults to sequential workspace subprocesses", async () => {
    const manifest = {
      version: 1,
      workspaces: [
        {
          ...BASE_WORKSPACE,
          name: "fixture-a",
          root: "fixture-a",
          ruleZones: PERMANENT_RULE_ZONES,
        },
        {
          ...BASE_WORKSPACE,
          name: "fixture-b",
          root: "fixture-b",
          ruleZones: PERMANENT_RULE_ZONES,
        },
      ],
    } satisfies ArchitectureManifest;
    const visited: string[] = [];
    let active = 0;
    let maxActive = 0;
    const hasFindings = await analyzeArchitectureInWorkspaceProcesses(
      REPOSITORY_ROOT,
      manifest,
      async (_root, workspaceRoot) => {
        visited.push(workspaceRoot);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );

    expect(visited).toEqual(["fixture-a", "fixture-b"]);
    expect(maxActive).toBe(1);
    expect(hasFindings).toBeFalse();
  });

  test("limits workspace subprocess concurrency to two", async () => {
    const manifest = {
      version: 1,
      workspaces: [
        {
          ...BASE_WORKSPACE,
          name: "fixture-a",
          root: "fixture-a",
          ruleZones: PERMANENT_RULE_ZONES,
        },
        {
          ...BASE_WORKSPACE,
          name: "fixture-b",
          root: "fixture-b",
          ruleZones: PERMANENT_RULE_ZONES,
        },
        {
          ...BASE_WORKSPACE,
          name: "fixture-c",
          root: "fixture-c",
          ruleZones: PERMANENT_RULE_ZONES,
        },
        {
          ...BASE_WORKSPACE,
          name: "fixture-d",
          root: "fixture-d",
          ruleZones: PERMANENT_RULE_ZONES,
        },
      ],
    } satisfies ArchitectureManifest;
    const visited: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirstPair: (() => void) | undefined;
    const firstPairReleased = new Promise<void>((resolve) => {
      releaseFirstPair = resolve;
    });
    let observeFirstPair: (() => void) | undefined;
    const firstPairStarted = new Promise<void>((resolve) => {
      observeFirstPair = resolve;
    });
    const analysis = analyzeArchitectureInWorkspaceProcesses(
      REPOSITORY_ROOT,
      manifest,
      async (_root, workspaceRoot) => {
        visited.push(workspaceRoot);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === 2) observeFirstPair?.();
        if (workspaceRoot === "fixture-a" || workspaceRoot === "fixture-b") {
          await firstPairReleased;
        }
        active -= 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      { workers: 2 },
    );

    await firstPairStarted;
    expect(visited).toEqual(["fixture-a", "fixture-b"]);
    releaseFirstPair?.();
    await analysis;
    expect(visited).toEqual(["fixture-a", "fixture-b", "fixture-c", "fixture-d"]);
    expect(maxActive).toBe(2);
  });

  test("emits workspace output in manifest order and aggregates findings", async () => {
    const manifest = {
      version: 1,
      workspaces: [
        {
          ...BASE_WORKSPACE,
          name: "fixture-a",
          root: "fixture-a",
          ruleZones: PERMANENT_RULE_ZONES,
        },
        {
          ...BASE_WORKSPACE,
          name: "fixture-b",
          root: "fixture-b",
          ruleZones: PERMANENT_RULE_ZONES,
        },
        {
          ...BASE_WORKSPACE,
          name: "fixture-c",
          root: "fixture-c",
          ruleZones: PERMANENT_RULE_ZONES,
        },
      ],
    } satisfies ArchitectureManifest;
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let observeThird: (() => void) | undefined;
    const thirdStarted = new Promise<void>((resolve) => {
      observeThird = resolve;
    });
    const completionOrder: string[] = [];
    const emitted: string[] = [];
    const analysis = analyzeArchitectureInWorkspaceProcesses(
      REPOSITORY_ROOT,
      manifest,
      async (_root, workspaceRoot) => {
        if (workspaceRoot === "fixture-a") await firstReleased;
        if (workspaceRoot === "fixture-c") observeThird?.();
        completionOrder.push(workspaceRoot);
        return {
          exitCode: workspaceRoot === "fixture-b" ? 0 : ARCHITECTURE_FINDINGS_EXIT_CODE,
          stdout: `stdout:${workspaceRoot}\n`,
          stderr: `stderr:${workspaceRoot}\n`,
        };
      },
      {
        workers: 2,
        writeStdout(output) {
          emitted.push(output);
        },
        writeStderr(output) {
          emitted.push(output);
        },
      },
    );

    await thirdStarted;
    releaseFirst?.();
    expect(await analysis).toBeTrue();
    expect(completionOrder).toEqual(["fixture-b", "fixture-c", "fixture-a"]);
    expect(emitted).toEqual(
      ["fixture-a", "fixture-b", "fixture-c"].flatMap((workspaceRoot) => [
        `stdout:${workspaceRoot}\n`,
        `stderr:${workspaceRoot}\n`,
      ]),
    );
  });

  test("fails closed when a workspace subprocess cannot complete", async () => {
    const manifest = {
      version: 1,
      workspaces: [
        {
          ...BASE_WORKSPACE,
          name: "fixture-a",
          root: "fixture-a",
          ruleZones: PERMANENT_RULE_ZONES,
        },
        {
          ...BASE_WORKSPACE,
          name: "fixture-b",
          root: "fixture-b",
          ruleZones: PERMANENT_RULE_ZONES,
        },
        {
          ...BASE_WORKSPACE,
          name: "fixture-c",
          root: "fixture-c",
          ruleZones: PERMANENT_RULE_ZONES,
        },
      ],
    } satisfies ArchitectureManifest;
    const visited: string[] = [];
    await expect(
      analyzeArchitectureInWorkspaceProcesses(
        REPOSITORY_ROOT,
        manifest,
        async (_root, workspaceRoot) => {
          visited.push(workspaceRoot);
          return {
            exitCode: workspaceRoot === "fixture-b" ? 2 : 0,
            stdout: "",
            stderr: "",
          };
        },
      ),
    ).rejects.toThrow("Architecture analysis subprocess for fixture-b failed with exit code 2");
    expect(visited).toEqual(["fixture-a", "fixture-b"]);
  });

  test("parses the explicit architecture worker option", () => {
    expect(parseArchitectureWorkerCount([])).toBe(1);
    expect(parseArchitectureWorkerCount(["--workers=2"])).toBe(2);
    expect(() => parseArchitectureWorkerCount(["--workers=0"])).toThrow(
      "Architecture worker count must be a positive integer",
    );
    expect(() => parseArchitectureWorkerCount(["--workers", "2"])).toThrow(
      "Unknown architecture option '--workers'",
    );
  });
});
