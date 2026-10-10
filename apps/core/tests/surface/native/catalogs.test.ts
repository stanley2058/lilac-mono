import { expect, it } from "bun:test";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils/core-config";
import { NativeCatalogService } from "../../../src/surface/native/catalogs";

it("projects display data without provider options or skill paths and reuses revision", () => {
  const config = parseCoreConfigV2ToUniversal({
    models: {
      def: {
        demo: { model: "openai/demo", options: { private: { token: "secret" } }, comment: "Demo" },
      },
      main: { model: "demo" },
    },
  });
  const service = new NativeCatalogService({
    config,
    commands: [],
    skills: [
      {
        name: "test",
        description: "Test",
        source: "lilac-data",
        location: "/private/SKILL.md",
        baseDir: "/private",
      },
    ],
  });
  const reply = service.get({ key: "owner" });
  expect(reply.kind).toBe("catalog");
  if (reply.kind !== "catalog") return;
  expect(JSON.stringify(reply)).not.toContain("secret");
  expect(JSON.stringify(reply)).not.toContain("/private");
  expect(service.get({ key: "owner" }, reply.catalog.revision)).toEqual({
    kind: "unchanged",
    revision: reply.catalog.revision,
  });
  const restricted = service.get({ key: "participant", skillNames: new Set() });
  if (restricted.kind !== "catalog") return;
  expect(restricted.catalog.skills).toEqual([]);
  expect(restricted.catalog.revision).not.toBe(reply.catalog.revision);
});

it("identity changes invalidate the catalog once and survive model catalog reloads", () => {
  const source = {
    config: parseCoreConfigV2ToUniversal({ models: { main: { model: "openai/demo" } } }),
    commands: [],
    skills: [],
  };
  const service = new NativeCatalogService(source);
  let notifications = 0;
  service.subscribe(() => notifications++);
  service.setAgent({
    id: "lilac",
    displayName: "Garden",
    avatarUrl: "/api/identity/avatar?revision=one",
  });
  const first = service.get({ key: "owner" });
  if (first.kind !== "catalog") throw new Error("Expected catalog");
  expect(first.catalog.agent?.displayName).toBe("Garden");
  service.setAgent({
    id: "lilac",
    displayName: "Garden",
    avatarUrl: "/api/identity/avatar?revision=one",
  });
  expect(notifications).toBe(1);
  service.setAgent({
    id: "lilac",
    displayName: "Garden",
    avatarUrl: "/api/identity/avatar?revision=two",
  });
  expect(service.get({ key: "owner" }, first.catalog.revision).kind).toBe("catalog");
  service.update(source);
  const reloaded = service.get({ key: "participant" });
  if (reloaded.kind !== "catalog") throw new Error("Expected catalog");
  expect(reloaded.catalog.agent?.avatarUrl).toContain("revision=two");
});

it("projects custom command arguments for composer completion", () => {
  const service = new NativeCatalogService({
    config: parseCoreConfigV2ToUniversal({ models: { main: { model: "openai/demo" } } }),
    skills: [],
    commands: [
      {
        name: "tarot",
        description: "Draw cards",
        args: [
          { key: "count", type: "number", required: true, description: "Cards to draw" },
          { key: "mode", type: "string", required: false, choices: ["single", "spread"] },
        ],
      },
    ],
  });
  const reply = service.get({ key: "owner" });
  if (reply.kind !== "catalog") throw new Error("Expected catalog");
  expect(reply.catalog.commands.find((command) => command.id === "custom:tarot")).toMatchObject({
    argumentHint: "<count> [mode]",
    arguments: [
      { key: "count", type: "number", required: true, description: "Cards to draw" },
      { key: "mode", type: "string", required: false, choices: ["single", "spread"] },
    ],
  });
});
