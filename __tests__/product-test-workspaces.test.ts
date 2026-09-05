import { describe, expect, test } from "bun:test";
import path from "node:path";

interface PackageManifest {
  readonly name: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

const repositoryRoot = path.resolve(import.meta.dir, "..");
const rootPackage: PackageManifest & { readonly workspaces: readonly string[] } = await Bun.file(
  path.join(repositoryRoot, "package.json"),
).json();
const workspaceManifests = rootPackage.workspaces.flatMap((pattern) => [
  ...new Bun.Glob(`${pattern}/package.json`).scanSync(repositoryRoot),
]);
const workspacePackages: readonly PackageManifest[] = await Promise.all(
  workspaceManifests.map((file) => Bun.file(path.join(repositoryRoot, file)).json()),
);
const packagesByName = new Map(workspacePackages.map((manifest) => [manifest.name, manifest]));

describe("product test workspace selections", () => {
  test.each(["test:core", "test:mini"])(
    "%s includes every selected workspace dependency",
    (script) => {
      const command = rootPackage.scripts?.[script];
      expect(command).toBeDefined();
      const selected = new Set(
        [...(command ?? "").matchAll(/--filter='([^']+)'/gu)].map((match) => match[1]),
      );
      expect(selected.size).toBeGreaterThan(0);
      const missing: string[] = [];
      for (const name of selected) {
        const manifest = name ? packagesByName.get(name) : undefined;
        expect(manifest, `Unknown workspace selected by ${script}: ${name}`).toBeDefined();
        const dependencies = {
          ...manifest?.dependencies,
          ...manifest?.devDependencies,
          ...manifest?.peerDependencies,
          ...manifest?.optionalDependencies,
        };
        for (const dependency of Object.keys(dependencies)) {
          if (!packagesByName.has(dependency) || selected.has(dependency)) continue;
          missing.push(`${name} -> ${dependency}`);
        }
      }
      expect(missing, `${script} omits workspace dependencies`).toEqual([]);
    },
  );
});
