import { describe, expect, it } from "bun:test";
import { tool } from "ai";
import { z } from "zod";

import {
  buildUnifiedToolCatalogResult,
  createPortableToolSearch,
  formatCatalogNamespaceSummary,
  type CatalogToolCandidate,
} from "../../src/mcp/catalog";
import {
  assignCatalogToolNames,
  baseCatalogToolName,
  catalogToolStableId,
} from "../../src/mcp/catalog-identity";

function buildUnifiedToolCatalog(params: Parameters<typeof buildUnifiedToolCatalogResult>[0]) {
  const catalog = buildUnifiedToolCatalogResult(params);
  if (catalog.status === "error") throw catalog.error;
  return catalog.value;
}

function executable(description = "fixture description") {
  return tool({
    description,
    inputSchema: z.object({}),
    execute: () => ({ ok: true }),
  });
}

function candidate(params: {
  source: "plugin" | "mcp";
  sourceId: string;
  rawName: string;
  title?: string;
  description?: string;
  namespaceSummary?: string;
}): CatalogToolCandidate {
  return {
    identity: {
      source: params.source,
      sourceId: params.sourceId,
      rawToolName: params.rawName,
    },
    ...(params.title === undefined ? {} : { title: params.title }),
    ...(params.description === undefined ? {} : { description: params.description }),
    ...(params.namespaceSummary === undefined ? {} : { namespaceSummary: params.namespaceSummary }),
    tool: executable(params.description),
  };
}

function executableSearch(searchTool: unknown) {
  if (
    !searchTool ||
    typeof searchTool !== "object" ||
    !("execute" in searchTool) ||
    typeof searchTool.execute !== "function"
  ) {
    throw new Error("portable find_tools is not executable");
  }
  return searchTool.execute;
}

describe("unified deferred tool catalog", () => {
  it("formats deterministic one-line MCP namespace summaries in find_tools", () => {
    expect(formatCatalogNamespaceSummary({ source: "mcp", sourceId: "solo", toolCount: 1 })).toBe(
      "mcp_solo.* — 1 tool",
    );

    const search = createPortableToolSearch({
      catalog: [],
      namespaceSummaries: [
        { source: "mcp", sourceId: "zeta", toolCount: 2 },
        {
          source: "mcp",
          sourceId: "excalidraw",
          toolCount: 37,
          description:
            "  diagrams, presentations, scene editing,\nimages, collections, workspace administration  ",
        },
      ],
    });
    expect((search as { description?: string }).description).toBe(
      [
        "Search deferred plugin and MCP tools. Use keywords for ranked search, select:name,... for exact model-facing names, or +term to require a term in tool names. Returned tools become available on the next model step.",
        "Available MCP namespaces:\nmcp_excalidraw.* — 37 tools: diagrams, presentations, scene editing, images, collections, workspace administration\nmcp_zeta.* — 2 tools",
      ].join("\n\n"),
    );
  });

  it("assigns deterministic qualified names without raw plugin aliases", () => {
    const candidates = [
      candidate({ source: "plugin", sourceId: "fixture", rawName: "shared tool" }),
      candidate({ source: "plugin", sourceId: "fixture", rawName: "shared-tool" }),
      candidate({ source: "mcp", sourceId: "docs", rawName: "shared-tool" }),
    ];

    const first = buildUnifiedToolCatalog({ candidates });
    const reversed = buildUnifiedToolCatalog({ candidates: [...candidates].reverse() });

    expect(first.entries.map((entry) => entry.modelName)).toEqual(
      reversed.entries.map((entry) => entry.modelName),
    );
    const normalizedCollisionNames = first.entries
      .filter((entry) => entry.source === "plugin")
      .map((entry) => entry.modelName);
    expect(new Set(normalizedCollisionNames).size).toBe(2);
    expect(
      normalizedCollisionNames.every((name) =>
        /^plugin_fixture_shared_tool_[a-f0-9]{10}$/.test(name),
      ),
    ).toBe(true);
    expect(first.byModelName.has("mcp_docs_shared_tool")).toBe(true);
    expect(first.byModelName.has("shared-tool")).toBe(false);
    expect(first.byModelName.has("shared tool")).toBe(false);
  });

  it("fails clearly when reserved names exhaust deterministic collision resolution", () => {
    const entry = candidate({ source: "mcp", sourceId: "reserved", rawName: "tool" });
    const baseName = baseCatalogToolName(entry.identity);
    const hashedName = assignCatalogToolNames([entry.identity], new Set([baseName])).byStableId.get(
      catalogToolStableId(entry.identity),
    );
    if (!hashedName) throw new Error("fixture identity did not receive a hashed name");

    const built = buildUnifiedToolCatalogResult({
      candidates: [entry],
      reservedNames: new Set([baseName, hashedName]),
    });
    expect(built.status).toBe("error");
    if (built.status === "error") {
      expect(built.error).toMatchObject({
        _tag: "UnifiedToolCatalogInvalid",
        reason: "name-collision",
      });
    }
  });

  it("searches one MCP and plugin catalog across source, raw name, title, and full description", async () => {
    const longDescription = `Complete original description ${"x".repeat(4_096)} final-keyword`;
    const catalog = buildUnifiedToolCatalog({
      candidates: [
        candidate({
          source: "plugin",
          sourceId: "calendar-plugin",
          rawName: "create-event",
          title: "Schedule meeting",
          description: longDescription,
        }),
        candidate({
          source: "mcp",
          sourceId: "company-wiki",
          rawName: "lookup-page",
          title: "Knowledge lookup",
          description: "Search internal documentation",
          namespaceSummary: "mcp_company_wiki.* — 1 tool: Internal documentation",
        }),
      ],
    });
    const execute = executableSearch(createPortableToolSearch({ catalog: catalog.entries }));

    expect(catalog.entries.find((entry) => entry.source === "plugin")?.description).toBe(
      longDescription,
    );
    expect(catalog.catalogMetadata.plugin_calendar_plugin_create_event?.description).toBe(
      longDescription,
    );
    expect(catalog.catalogMetadata.mcp_company_wiki_lookup_page?.namespaceSummary).toBe(
      "mcp_company_wiki.* — 1 tool: Internal documentation",
    );
    expect(
      await execute({ query: "COMPANY-WIKI" }, { toolCallId: "source", messages: [] }),
    ).toMatchObject({ matches: [{ source: "mcp", rawName: "lookup-page" }] });
    expect(
      await execute(
        { query: "MCP_COMPANY_WIKI_LOOKUP_PAGE" },
        { toolCallId: "model-name", messages: [] },
      ),
    ).toMatchObject({ matches: [{ source: "mcp", rawName: "lookup-page" }] });
    expect(
      await execute({ query: "create-event" }, { toolCallId: "raw", messages: [] }),
    ).toMatchObject({ matches: [{ source: "plugin", sourceId: "calendar-plugin" }] });
    expect(
      await execute({ query: "SCHEDULE MEETING" }, { toolCallId: "title", messages: [] }),
    ).toMatchObject({ matches: [{ source: "plugin" }] });
    expect(
      await execute({ query: "FINAL-KEYWORD" }, { toolCallId: "description", messages: [] }),
    ).toMatchObject({ matches: [{ source: "plugin" }] });
  });

  it("ranks name matches above metadata-only matches and supports fuzzy keywords", async () => {
    const catalog = buildUnifiedToolCatalog({
      candidates: [
        candidate({
          source: "mcp",
          sourceId: "jupyter",
          rawName: "notebook-open",
          title: "Open a workspace",
          description: "Load a file.",
        }),
        candidate({
          source: "plugin",
          sourceId: "archive",
          rawName: "read-entry",
          title: "Archive reader",
          description: "Read an archived notebook.",
        }),
      ],
    });
    const execute = executableSearch(createPortableToolSearch({ catalog: catalog.entries }));

    const ranked = await execute({ query: "notebook" }, { toolCallId: "ranked", messages: [] });
    expect(ranked).toMatchObject({
      queryType: "ranked",
      matches: [{ sourceId: "jupyter" }, { sourceId: "archive" }],
    });

    const fuzzy = await execute({ query: "ntbk" }, { toolCallId: "fuzzy", messages: [] });
    expect(fuzzy).toMatchObject({ matches: [{ sourceId: "jupyter" }] });
  });

  it("selects exact model-facing names in query order and reports missing names", async () => {
    const selections: string[][] = [];
    const catalog = buildUnifiedToolCatalog({
      candidates: [
        candidate({ source: "plugin", sourceId: "calendar", rawName: "create-event" }),
        candidate({ source: "mcp", sourceId: "wiki", rawName: "lookup-page" }),
      ],
    });
    const [first, second] = catalog.entries;
    if (!first || !second) throw new Error("expected two catalog entries");
    const execute = executableSearch(
      createPortableToolSearch({
        catalog: catalog.entries,
        onSelectCatalogIds: (catalogIds) => selections.push([...catalogIds]),
      }),
    );

    const result = await execute(
      {
        query: `select:${second.modelName.toUpperCase()},${first.modelName},missing_tool`,
        max_results: 2,
      },
      { toolCallId: "select", messages: [] },
    );

    expect(result).toMatchObject({
      queryType: "select",
      matches: [{ name: second.modelName }, { name: first.modelName }],
      missing: ["missing_tool"],
    });
    expect(selections).toEqual([[second.stableId, first.stableId]]);
  });

  it("requires +terms in tool names while remaining keywords rank matches", async () => {
    const catalog = buildUnifiedToolCatalog({
      candidates: [
        candidate({ source: "mcp", sourceId: "slack", rawName: "send-message" }),
        candidate({ source: "mcp", sourceId: "slack", rawName: "history" }),
        candidate({ source: "mcp", sourceId: "email", rawName: "send-message" }),
      ],
    });
    const execute = executableSearch(createPortableToolSearch({ catalog: catalog.entries }));

    const result = await execute(
      { query: "+slack send" },
      { toolCallId: "required-name", messages: [] },
    );
    expect(result).toMatchObject({
      queryType: "ranked",
      matches: [
        { sourceId: "slack", rawName: "send-message" },
        { sourceId: "slack", rawName: "history" },
      ],
    });
    expect(
      (result as { matches: Array<{ sourceId: string }> }).matches.map((match) => match.sourceId),
    ).toEqual(["slack", "slack"]);
  });

  it("defaults to five ranked results and accepts a larger explicit result count", async () => {
    const catalog = buildUnifiedToolCatalog({
      candidates: Array.from({ length: 8 }, (_, index) =>
        candidate({
          source: "mcp",
          sourceId: `source-${index}`,
          rawName: `marker-tool-${index}`,
        }),
      ),
    });
    const execute = executableSearch(createPortableToolSearch({ catalog: catalog.entries }));

    const defaultResult = await execute(
      { query: "marker" },
      { toolCallId: "default-max", messages: [] },
    );
    const expandedResult = await execute(
      { query: "marker", max_results: 8 },
      { toolCallId: "expanded-max", messages: [] },
    );
    expect((defaultResult as { matches: unknown[] }).matches).toHaveLength(5);
    expect((expandedResult as { matches: unknown[] }).matches).toHaveLength(8);
  });

  it("retains and can explicitly return all 5,000 catalog entries", async () => {
    const catalog = buildUnifiedToolCatalog({
      candidates: Array.from({ length: 5_000 }, (_, index) =>
        candidate({
          source: index % 2 === 0 ? "plugin" : "mcp",
          sourceId: `source-${index % 10}`,
          rawName: `large-catalog-tool-${index}`,
          description: "large catalog marker",
        }),
      ),
    });
    const execute = executableSearch(createPortableToolSearch({ catalog: catalog.entries }));
    const result = await execute(
      { query: "large catalog marker", max_results: 5_000 },
      { toolCallId: "large", messages: [] },
    );

    expect(catalog.entries).toHaveLength(5_000);
    expect((result as { matches: unknown[] }).matches).toHaveLength(5_000);
  });
});
