import fs from "node:fs";
import path from "node:path";

export function hasWorkspacesField(pkgJsonPath: string): boolean {
  try {
    const raw = fs.readFileSync(pkgJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { workspaces?: unknown };
    return pkg.workspaces != null;
  } catch {
    return false;
  }
}

export function findWorkspaceRoot(startDir = process.cwd()): string {
  let dir = path.resolve(startDir);

  while (true) {
    const pkgJsonPath = path.join(dir, "package.json");

    if (fs.existsSync(pkgJsonPath) && hasWorkspacesField(pkgJsonPath)) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Workspace root not found from: ${startDir} (no package.json with workspaces)`,
      );
    }

    dir = parent;
  }
}
