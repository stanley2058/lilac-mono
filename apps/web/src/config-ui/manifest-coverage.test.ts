import { describe, expect, it } from "bun:test";
import { coreManifest } from "./core-manifest";
import { mcpManifest } from "./mcp-manifest";
import {
  staleConfigPaths,
  uncoveredConfigFields,
  unexplainedUnplacedFields,
  unhandledEditorFields,
} from "./manifest-coverage";
import { enumerateConfigFields } from "@stanley2058/lilac-utils/config-schema";
import { configSchema } from "./schemas";

// A failure here means a config field was added or renamed. Give it a place in the manifest, or
// list it in `unplaced` with the reason it is YAML-only.
describe.each([
  ["core", coreManifest],
  ["mcp", mcpManifest],
] as const)("%s settings manifest", (_kind, manifest) => {
  it("decodes the generated schema", () => {
    const { schema, root } = configSchema(manifest.kind);
    expect(enumerateConfigFields(schema, root).length).toBeGreaterThan(20);
  });

  it("places every schema field", () => {
    expect(uncoveredConfigFields(manifest)).toEqual([]);
  });

  it("has a control for every child of fixed editors", () => {
    expect(unhandledEditorFields(manifest)).toEqual([]);
  });

  it("gives a reason for every YAML-only field", () => {
    expect(unexplainedUnplacedFields(manifest)).toEqual([]);
  });

  it("names only existing fields", () => {
    expect(staleConfigPaths(manifest)).toEqual([]);
  });

  it("keeps page ids unique", () => {
    const ids = manifest.pages.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
