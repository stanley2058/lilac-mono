import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { architectureManifest, type ArchitectureManifest } from "../architecture/manifest.ts";
import { validateWorkspaceInventory } from "../architecture/workspace-inventory.ts";
import {
  findBlobStorageSeamViolationsInSourceFile,
  findDirectSqliteTransactionViolationsInSourceFile,
  findElseAfterTerminalViolationsInSourceFile,
  findExceptionFlowViolationsInSourceFile,
  findInlineAsyncResultCallbackViolationsInSourceFile,
  findPresentationDecoderImportViolationsInSourceFile,
  findPreferSwitchTrueChainViolationsInSourceFile,
  findRedundantBranchViolationsInSourceFile,
  findStoreInlineDecodingViolationsInSourceFile,
  parseProductionSyntaxSource,
} from "./production-syntax.mts";
import { type ActiveSyntaxRule, SYNTACTIC_POLICY } from "./syntax-policy.mts";
import {
  createProductionFileExclusionMatcher,
  normalizeFilePath,
  type SyntacticFinding,
} from "./syntax-rule-utils.mts";

export interface SyntaxFinding {
  readonly workspace: string;
  readonly module: string;
  readonly symbol: string;
  readonly kind: string;
  readonly digest: string;
  readonly rule: ActiveSyntaxRule;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

const ACTIVE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;
const REPOSITORY_ROOT = join(import.meta.dir, "../..");
const isExcludedFromStandaloneScan = createProductionFileExclusionMatcher(
  SYNTACTIC_POLICY.productionExclusions,
);

interface ProductionFile {
  readonly filePath: string;
  readonly physicalPath: string;
}

async function productionFiles(
  physicalDirectory: string,
  logicalDirectory: string,
): Promise<ProductionFile[]> {
  const entries = await readdir(physicalDirectory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const physicalPath = join(physicalDirectory, entry.name);
      const filePath = normalizeFilePath(join(logicalDirectory, entry.name));
      if (isExcludedFromStandaloneScan(filePath)) return [];
      if (entry.isDirectory()) return productionFiles(physicalPath, filePath);
      return entry.isFile() && ACTIVE_EXTENSION.test(filePath) ? [{ filePath, physicalPath }] : [];
    }),
  );
  return nested.flat();
}

function toSyntaxFindings<Kind extends string>(
  rule: ActiveSyntaxRule,
  findings: readonly SyntacticFinding<Kind>[],
): SyntaxFinding[] {
  return findings.map((finding) => ({ ...finding, rule }));
}

export async function scanSyntaxFindings(
  manifest: ArchitectureManifest = architectureManifest,
  rootDirectory = REPOSITORY_ROOT,
): Promise<SyntaxFinding[]> {
  const findings: SyntaxFinding[] = [];
  for (const workspace of manifest.workspaces) {
    const paths = (await productionFiles(join(rootDirectory, workspace.root), workspace.root)).sort(
      (left, right) => left.filePath.localeCompare(right.filePath),
    );
    for (const { filePath, physicalPath } of paths) {
      const source = await readFile(physicalPath, "utf8");
      const sourceFile = parseProductionSyntaxSource(source, filePath);
      findings.push(
        ...toSyntaxFindings(
          "lilac/blob-storage-seam",
          findBlobStorageSeamViolationsInSourceFile(sourceFile, filePath, manifest),
        ),
        ...toSyntaxFindings(
          "lilac/no-else-after-terminal",
          findElseAfterTerminalViolationsInSourceFile(sourceFile, filePath),
        ),
        ...toSyntaxFindings(
          "lilac/no-exception-flow",
          findExceptionFlowViolationsInSourceFile(sourceFile, filePath, manifest),
        ),
        ...toSyntaxFindings(
          "lilac/no-inline-async-result-callback",
          findInlineAsyncResultCallbackViolationsInSourceFile(sourceFile, filePath),
        ),
        ...toSyntaxFindings(
          "lilac/no-presentation-decoder-import",
          findPresentationDecoderImportViolationsInSourceFile(sourceFile, filePath, manifest),
        ),
        ...toSyntaxFindings(
          "lilac/no-redundant-branch",
          findRedundantBranchViolationsInSourceFile(sourceFile, filePath),
        ),
        ...toSyntaxFindings(
          "lilac/no-store-inline-decoding",
          findStoreInlineDecodingViolationsInSourceFile(sourceFile, filePath, manifest),
        ),
        ...toSyntaxFindings(
          "lilac/no-direct-sqlite-transaction",
          findDirectSqliteTransactionViolationsInSourceFile(sourceFile, filePath, manifest),
        ),
        ...toSyntaxFindings(
          "lilac/prefer-switch-true-chain",
          findPreferSwitchTrueChainViolationsInSourceFile(sourceFile, filePath),
        ),
      );
    }
  }
  const scriptsDirectory = join(rootDirectory, "scripts");
  if (existsSync(scriptsDirectory)) {
    const paths = (await productionFiles(scriptsDirectory, "scripts")).sort((left, right) =>
      left.filePath.localeCompare(right.filePath),
    );
    for (const { filePath, physicalPath } of paths) {
      const source = await readFile(physicalPath, "utf8");
      findings.push(
        ...toSyntaxFindings(
          "lilac/blob-storage-seam",
          findBlobStorageSeamViolationsInSourceFile(
            parseProductionSyntaxSource(source, filePath),
            filePath,
            manifest,
          ),
        ),
      );
    }
  }
  return findings;
}

export function formatSyntaxDiagnostic(finding: SyntaxFinding): string {
  const location = `${finding.workspace}/${finding.module}:${finding.line}:${finding.column}`;
  return `${location} error ${finding.rule} [${finding.symbol}/${finding.kind}] ${finding.message} [digest=${finding.digest}]`;
}

async function main(): Promise<void> {
  const repositoryRoot = join(import.meta.dir, "../..");
  await validateWorkspaceInventory(repositoryRoot);
  const findings = await scanSyntaxFindings();
  for (const finding of findings) console.error(formatSyntaxDiagnostic(finding));
  console.log(`syntax gate: ${findings.length} errors`);
  if (findings.length > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
