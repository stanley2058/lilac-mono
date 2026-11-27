import { expect, test } from "bun:test";
import { Result } from "better-result";
import { createNativeIntegrationFixture } from "./integration-fixture";

test("config.mcpStatus returns minimal server status to the owner only", async () => {
  const fixture = await createNativeIntegrationFixture({
    mcpRegistry: {
      reload: async () => Result.ok([]),
      getCatalogServers: () => [],
      getTools: () => [],
      list: () => [
        { serverId: "docs", transport: "http", status: "available", toolCount: 4 },
        {
          serverId: "local",
          transport: "stdio",
          status: "unavailable",
          phase: "connection",
          error: "x".repeat(5000),
        },
        {
          serverId: "remote",
          transport: "http",
          status: "authentication_required",
          phase: "connection",
          error: "Authorization required",
        },
      ],
    },
    additionalLocalUsers: [
      { userId: "reader", username: "reader", password: "reader-fixture-password" },
    ],
  });
  try {
    const owner = fixture.connect().client;
    const reader = fixture.connect(
      await fixture.loginAs("reader", "reader-fixture-password"),
    ).client;
    expect(await owner.config.mcpStatus({})).toEqual({
      servers: [
        { name: "docs", transport: "http", state: "available", toolCount: 4 },
        { name: "local", transport: "stdio", state: "unavailable", error: "x".repeat(4096) },
        {
          name: "remote",
          transport: "http",
          state: "authentication_required",
          error: "Authorization required",
        },
      ],
    });
    await expect(reader.config.mcpStatus({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  } finally {
    await fixture.close();
  }
});
