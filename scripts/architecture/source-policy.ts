import path from "node:path";

export interface ProductionExclusion {
  readonly pattern: string;
  readonly reason: string;
}

export const PRODUCTION_FILE_EXCLUSIONS = [
  {
    pattern: "(?:^|/)(?:tests?|__tests__)(?:/|$)",
    reason: "Production policy does not apply to test support trees",
  },
  {
    pattern: "\\.(?:spec|test)\\.[cm]?[jt]sx?$",
    reason: "Production policy does not apply to test modules",
  },
  {
    pattern: "(?:^|/)(?:dist|generated)(?:/|$)",
    reason: "Generated output is enforced at its source module",
  },
  {
    pattern: "(?:^|/)vendor(?:/|$)",
    reason: "Vendored third-party source is enforced by its upstream project",
  },
  {
    pattern: "(?:^|/)apps/core/src/ssh/remote-js/remote-runner\\.cjs$",
    reason: "Generated remote runner bundle is enforced at its TypeScript source",
  },
] as const satisfies readonly ProductionExclusion[];

export type ProductionFileExclusionMatcher = (filePath: string) => boolean;

export function createProductionFileExclusionMatcher(
  exclusions: readonly Pick<ProductionExclusion, "pattern">[],
): ProductionFileExclusionMatcher {
  const patterns = exclusions.map((exclusion) => new RegExp(exclusion.pattern, "iu"));
  return (filePath) => {
    const normalized = filePath.replaceAll("\\", "/");
    return patterns.some((pattern) => pattern.test(normalized));
  };
}

const isExcludedProductionFile = createProductionFileExclusionMatcher(PRODUCTION_FILE_EXCLUSIONS);

export function isProductionFileName(fileName: string, workspaceRoot: string): boolean {
  const relative = path.relative(workspaceRoot, fileName).replaceAll("\\", "/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return false;
  const scope = path.basename(path.dirname(workspaceRoot));
  const scopedFileName =
    scope === "apps" || scope === "packages"
      ? `${scope}/${path.basename(workspaceRoot)}/${relative}`
      : relative;
  return !isExcludedProductionFile(scopedFileName);
}
