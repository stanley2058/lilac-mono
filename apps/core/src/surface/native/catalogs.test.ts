import { expect, test } from "bun:test";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils/core-config";
import { NativeCatalogService } from "./catalogs";

test("catalog puts the configured primary model first and preserves its description", () => {
  const config = parseCoreConfigV2ToUniversal({
    models: {
      main: { model: "primary" },
      def: {
        other: { model: "openai/other" },
        primary: { model: "openai/primary", comment: "Preferred model" },
      },
    },
  });
  const catalogs = new NativeCatalogService({ config, skills: [], commands: [] });
  const reply = catalogs.get({ key: "test" });
  expect(reply.kind).toBe("catalog");
  if (reply.kind !== "catalog") return;
  expect(reply.catalog.models).toEqual([
    { id: "primary", label: "primary", description: "Preferred model" },
    { id: "other", label: "other" },
  ]);
  catalogs.update({
    config: { ...config, models: { ...config.models, main: { model: "openai/direct" } } },
    skills: [],
    commands: [],
  });
  const updated = catalogs.get({ key: "test" });
  if (updated.kind !== "catalog") throw new Error("Expected catalog");
  expect(updated.catalog.models[0]?.id).toBe("openai/direct");
  expect(updated.catalog.revision).not.toBe(reply.catalog.revision);
});

test("legacy catalogs expose exactly configured choices even without provider credentials", async () => {
  const config = parseCoreConfigV2ToUniversal({
    models: {
      main: { model: "openai/private-model" },
      def: { alternate: { model: "anthropic/private-model" } },
    },
  });
  const catalogs = new NativeCatalogService({ config, skills: [], commands: [] });
  const page = await catalogs.models({});
  expect(page.models.map((model) => model.id).sort()).toEqual([
    "alternate",
    "openai/private-model",
  ]);
  for (const model of page.models) expect(catalogs.selection(model.id)).toBe(true);
  expect(catalogs.selection("openai/unconfigured")).toBe(false);
  expect(catalogs.selection(undefined, "provider-default")).toBe(true);
});
