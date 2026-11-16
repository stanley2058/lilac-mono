import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { architectureManifest, type ArchitectureManifest } from "../architecture/manifest.ts";
import { isProductionFileName } from "../architecture/source-policy.ts";
import { SYNTACTIC_POLICY } from "./syntax-policy.mts";
import { createProductionFileExclusionMatcher } from "./syntax-rule-utils.mts";

import {
  formatSyntaxDiagnostic,
  scanSyntaxFindings,
  type SyntaxFinding,
} from "./check-production-syntax.mts";

const FIXTURE_ROOT = new URL("./fixtures/production-syntax-gate/", import.meta.url).pathname;

function fixtureManifest(): ArchitectureManifest {
  const workspace = architectureManifest.workspaces[0];
  if (!workspace) throw new Error("fixture workspace template missing");
  return {
    ...architectureManifest,
    workspaces: [
      {
        ...workspace,
        name: "apps/example",
        packageName: "@example/app",
        root: "apps/example",
        exceptionAdapters: [],
        persistedStoreConsumers: [],
        sqliteTransactionConsumers: [],
        unknownFreeModules: [],
      },
    ],
  };
}

describe("repository syntax gate", () => {
  it.each([
    ["apps/core", "src/service.ts", true],
    ["apps/core", "src/fixtures/runtime.ts", true],
    ["apps/core", "tests/fixtures/support.ts", false],
    ["apps/core", "test/support.ts", false],
    ["apps/core", "__tests__/support.ts", false],
    ["apps/core", "src/service.test.ts", false],
    ["apps/core", "src/service.spec.mts", false],
    ["apps/core", "src/generated/output.ts", false],
    ["apps/core", "dist/main.js", false],
    ["apps/core", "src/vendor/library.ts", false],
    ["apps/web", "node_modules/.vite/deps/react.js", false],
    ["apps/example", "src/node_modules/dependency/index.ts", false],
    ["packages/example", "node_modules/dependency/index.ts", false],
    ["apps/example", "src/node_modules-helper.ts", true],
    ["packages/example", "src/fixtures/runtime.ts", true],
  ] as const)("shares production ownership for %s/%s", (workspace, module, expected) => {
    const root = path.resolve(import.meta.dir, "../..");
    const file = `${workspace}/${module}`;
    const syntaxExcluded = createProductionFileExclusionMatcher(
      SYNTACTIC_POLICY.productionExclusions,
    );
    expect(!syntaxExcluded(file)).toBe(expected);
    expect(!syntaxExcluded(path.join(root, file))).toBe(expected);
    expect(!syntaxExcluded(file.replaceAll("/", "\\"))).toBe(expected);
    expect(isProductionFileName(path.join(root, file), path.join(root, workspace))).toBe(expected);
  });

  it("discovers fixture sources, preserves fixture directories, and excludes tests before parsing", async () => {
    const findings = await scanSyntaxFindings(fixtureManifest(), FIXTURE_ROOT);

    expect(
      findings.map(({ workspace, module, symbol, kind, rule }) => ({
        workspace,
        module,
        symbol,
        kind,
        rule,
      })),
    ).toEqual([
      {
        workspace: "apps/example",
        module: "src/finding",
        symbol: "fail",
        kind: "throw",
        rule: "lilac/no-exception-flow",
      },
      {
        workspace: "apps/example",
        module: "src/fixtures/nested-finding",
        symbol: "failInFixture",
        kind: "throw",
        rule: "lilac/no-exception-flow",
      },
    ]);
  });

  it("skips nested dependency caches while checking adjacent workspace sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lilac-syntax-dependencies-"));
    const modules = [
      "node_modules/.vite/deps/optimized.js",
      "src/node_modules/dependency/index.ts",
      "src/runtime.ts",
      "src/node_modules-helper.ts",
    ];
    try {
      for (const module of modules) {
        const file = path.join(root, "apps/example", module);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'export function fail() { throw new Error("fixture"); }\n');
      }
      const findings = await scanSyntaxFindings(fixtureManifest(), root);
      expect(findings.map(({ module, rule }) => ({ module, rule }))).toEqual([
        { module: "src/node_modules-helper", rule: "lilac/no-exception-flow" },
        { module: "src/runtime", rule: "lilac/no-exception-flow" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("formats actionable diagnostics with the stable finding digest", () => {
    const finding = {
      workspace: "apps/example",
      module: "src/service",
      symbol: "captureFailure",
      kind: "try-statement",
      digest: "a".repeat(64),
      rule: "lilac/no-exception-flow",
      line: 12,
      column: 5,
      message: "Use object-form Result.try or Result.tryPromise",
    } satisfies SyntaxFinding;

    expect(formatSyntaxDiagnostic(finding)).toBe(
      `apps/example/src/service:12:5 error lilac/no-exception-flow [captureFailure/try-statement] Use object-form Result.try or Result.tryPromise [digest=${"a".repeat(64)}]`,
    );
  });
});
