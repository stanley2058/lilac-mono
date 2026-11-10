import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensurePromptWorkspace,
  parseCoreConfigV1ToUniversal,
  type CoreConfig,
} from "@stanley2058/lilac-utils";

import { DiscoveryService } from "../src/discovery/discovery-service";
import { DiscordSearchStore } from "../src/surface/store/discord-search-store";
import { Discovery } from "../src/tool-server/tools/discovery";
import { SqliteTranscriptStore } from "../src/transcript/transcript-store";

function testConfig(input: unknown): CoreConfig {
  const cfg = parseCoreConfigV1ToUniversal(input);
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

describe("tool-server discovery", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-discovery-"));
    tempDirs.push(root);
    const dataDir = path.join(root, "data");
    await fs.mkdir(dataDir, { recursive: true });
    await ensurePromptWorkspace({ dataDir, overwrite: true });

    await Bun.write(
      path.join(dataDir, "prompts", "MEMORY.md"),
      ["# Memory", "", "Remember the deploy playbook.", "Check release notes first."].join("\n"),
    );
    await Bun.write(
      path.join(dataDir, "prompts", "HEARTBEAT.md"),
      ["# Heartbeat", "", "Track deploy follow-ups.", "Escalate broken releases."].join("\n"),
    );
    await Bun.write(
      path.join(dataDir, "prompts", "heartbeat", "archive", "2026-03-27.md"),
      ["Yesterday deploy review", "", "Remember the deploy checklist.", "Archive note."].join("\n"),
    );

    const cfg = testConfig({
      entity: {
        sessions: {
          discord: {
            ops: "c1",
          },
        },
        users: {
          releaseCaptain: {
            discord: "u2",
          },
        },
      },
    });

    const discordSearchStore = new DiscordSearchStore(path.join(root, "discord-search.db"));
    const transcriptStore = new SqliteTranscriptStore(path.join(root, "transcripts.db"));
    const discoveryService = new DiscoveryService({
      dbPath: path.join(root, "discovery.db"),
      dataDir,
      discordSearchStore,
      transcriptStore,
      getConfig: async () => cfg,
    });

    const now = Date.now();
    const previousYearTs = new Date(new Date().getFullYear() - 1, 0, 2, 15, 4, 0, 0).getTime();
    discordSearchStore.upsertMessages([
      {
        ref: { platform: "discord", channelId: "c1", messageId: "m1" },
        session: { platform: "discord", channelId: "c1" },
        userId: "u1",
        userName: "alice",
        text: "start release prep",
        ts: now - 60_000,
      },
      {
        ref: { platform: "discord", channelId: "c1", messageId: "m2" },
        session: { platform: "discord", channelId: "c1" },
        userId: "u2",
        userName: "bob",
        text: "deploy completed successfully",
        ts: now - 50_000,
      },
      {
        ref: { platform: "discord", channelId: "c1", messageId: "m3" },
        session: { platform: "discord", channelId: "c1" },
        userId: "u3",
        userName: "carol",
        text: "post deploy checklist pending",
        ts: now - 40_000,
      },
      {
        ref: { platform: "discord", channelId: "c2", messageId: "m4" },
        session: { platform: "discord", channelId: "c2" },
        userId: "u4",
        userName: "dana",
        text: "old deploy thread",
        ts: now - 3 * 86_400_000,
      },
      {
        ref: { platform: "discord", channelId: "c4", messageId: "m5" },
        session: { platform: "discord", channelId: "c4" },
        userId: "u5",
        userName: "erin",
        text: "annual archive note",
        ts: previousYearTs,
      },
    ]);

    transcriptStore.saveRequestTranscript({
      requestId: "req-surface",
      sessionId: "c1",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "ignored" }],
      finalText: "deploy completed successfully",
      modelLabel: "test",
    });
    transcriptStore.linkSurfaceMessagesToRequest({
      requestId: "req-surface",
      created: [{ platform: "discord", channelId: "c1", messageId: "m2" }],
      last: { platform: "discord", channelId: "c1", messageId: "m2" },
    });

    transcriptStore.saveRequestTranscript({
      requestId: "req-orphan",
      sessionId: "c3",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "ignored" }],
      finalText: "deploy retrospective summary",
      modelLabel: "test",
    });
    transcriptStore.saveRequestTranscript({
      requestId: "req-orphan",
      sessionId: "c3",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "ignored" }],
      finalText: "deploy retrospective summary followup",
      modelLabel: "test",
    });

    transcriptStore.saveRequestTranscript({
      requestId: "req-github",
      sessionId: "owner/repo#12",
      requestClient: "github",
      messages: [{ role: "assistant", content: "ignored" }],
      finalText: "deploy review comment from github",
      modelLabel: "test",
    });
    transcriptStore.linkSurfaceMessagesToRequest({
      requestId: "req-github",
      created: [{ platform: "github", channelId: "owner/repo#12", messageId: "9001" }],
      last: { platform: "github", channelId: "owner/repo#12", messageId: "9001" },
    });

    const rawTool = new Discovery({ discovery: discoveryService });
    const tool = {
      list: () => rawTool.list(),
      callResult: (...args: Parameters<Discovery["call"]>) => rawTool.call(...args),
      async call(...args: Parameters<Discovery["call"]>): Promise<unknown> {
        const outcome = (await rawTool.call(...args)).match<
          { readonly value: unknown } | { readonly error: { readonly message: string } }
        >({
          ok: (value) => ({ value }),
          err: (error) => ({ error }),
        });
        if ("error" in outcome) throw new Error(outcome.error.message);
        return outcome.value;
      },
    };

    return {
      root,
      dataDir,
      now,
      tool,
      discoveryService,
      discordSearchStore,
      transcriptStore,
    };
  }

  it("pins restricted discovery to the caller and omits prompt and heartbeat sources", async () => {
    const fixture = await makeFixture();
    try {
      const result = (await fixture.tool.call(
        "discovery.search",
        { query: "deploy", sessionId: "c2", sources: ["conversation", "prompt", "heartbeat"] },
        { context: { safetyMode: "restricted", sessionId: "c1" } },
      )) as { groups: Array<{ source: string; origin?: { sessionId?: string } }> };
      expect(result.groups.length).toBeGreaterThan(0);
      for (const group of result.groups) {
        expect(group.source).toBe("conversation");
        expect(group.origin?.sessionId).toBe("c1");
      }
      expect(
        (
          await fixture.tool.callResult(
            "discovery.search",
            { query: "deploy" },
            { context: { safetyMode: "restricted" } },
          )
        ).isErr(),
      ).toBe(true);
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("skips unchanged transcript enumeration using the store change watermark", async () => {
    const fixture = await makeFixture();
    const list = spyOn(fixture.transcriptStore, "listDiscoveryRecords");
    try {
      await fixture.tool.call("discovery.search", { query: "deploy" });
      await fixture.tool.call("discovery.search", { query: "deploy" });
      expect(list).toHaveBeenCalledTimes(1);
      fixture.transcriptStore.saveRequestTranscript({
        requestId: "new-deploy",
        sessionId: "owner/repo#99",
        requestClient: "github",
        messages: [],
        finalText: "deploy watermark",
        modelLabel: "test",
      });
      await fixture.tool.call("discovery.search", { query: "deploy" });
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      list.mockRestore();
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  function openDiscoveryWriteAudit(dbPath: string): Database {
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE discovery_write_audit (operation TEXT NOT NULL);
      CREATE TRIGGER discovery_documents_audit_insert
      AFTER INSERT ON discovery_documents
      BEGIN
        INSERT INTO discovery_write_audit(operation) VALUES ('insert');
      END;
      CREATE TRIGGER discovery_documents_audit_update
      AFTER UPDATE ON discovery_documents
      BEGIN
        INSERT INTO discovery_write_audit(operation) VALUES ('update');
      END;
      CREATE TRIGGER discovery_documents_audit_delete
      AFTER DELETE ON discovery_documents
      BEGIN
        INSERT INTO discovery_write_audit(operation) VALUES ('delete');
      END;
    `);
    return db;
  }

  function discoveryWriteAuditRows(db: Database): unknown[] {
    return db
      .query(
        "SELECT operation, COUNT(*) AS count FROM discovery_write_audit GROUP BY operation ORDER BY operation",
      )
      .all();
  }

  it("does not write discovery documents on an identical repeated search", async () => {
    const fixture = await makeFixture();

    try {
      await fixture.discoveryService.search({ query: "deploy" });
      const audit = openDiscoveryWriteAudit(path.join(fixture.root, "discovery.db"));
      try {
        const dataVersionBefore = Number(audit.query("PRAGMA data_version").values()[0]?.[0]);
        await fixture.discoveryService.search({ query: "deploy" });
        expect(discoveryWriteAuditRows(audit)).toEqual([]);
        expect(Number(audit.query("PRAGMA data_version").values()[0]?.[0])).toBe(dataVersionBefore);
      } finally {
        audit.close();
      }
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  }, 20_000);

  it("updates only the edited discovery document", async () => {
    const fixture = await makeFixture();

    try {
      const agentsPath = path.join(fixture.dataDir, "prompts", "AGENTS.md");
      await Bun.write(agentsPath, "original discovery document\n");
      await fixture.discoveryService.search({ query: "original" });
      const audit = openDiscoveryWriteAudit(path.join(fixture.root, "discovery.db"));
      try {
        await Bun.write(agentsPath, "edited discovery document\n");
        await fixture.discoveryService.search({ query: "edited" });
        expect(discoveryWriteAuditRows(audit)).toEqual([{ operation: "update", count: 1 }]);
      } finally {
        audit.close();
      }
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("deletes discovery documents removed from a source", async () => {
    const fixture = await makeFixture();

    try {
      const agentsPath = path.join(fixture.dataDir, "prompts", "AGENTS.md");
      await Bun.write(agentsPath, "removable discovery document\n");
      await fixture.discoveryService.search({ query: "removable" });
      const audit = openDiscoveryWriteAudit(path.join(fixture.root, "discovery.db"));
      try {
        await Bun.write(agentsPath, "\n");
        await fixture.discoveryService.search({ query: "removable" });
        expect(discoveryWriteAuditRows(audit)).toEqual([{ operation: "delete", count: 1 }]);
      } finally {
        audit.close();
      }
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("shares one source synchronization across concurrent searches", async () => {
    const fixture = await makeFixture();
    const audit = openDiscoveryWriteAudit(path.join(fixture.root, "discovery.db"));

    try {
      await Promise.all(
        Array.from({ length: 4 }, () => fixture.discoveryService.search({ query: "deploy" })),
      );

      const documentCount = Number(
        audit.query("SELECT COUNT(*) FROM discovery_documents").values()[0]?.[0],
      );
      expect(discoveryWriteAuditRows(audit)).toEqual([
        { operation: "insert", count: documentCount },
      ]);
    } finally {
      audit.close();
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("groups by origin, dedupes linked transcripts, and hides verbose fields by default", async () => {
    const fixture = await makeFixture();

    try {
      const result = (await fixture.tool.call("discovery.search", {
        query: "deploy",
        sources: ["conversation", "prompt", "heartbeat"],
        groupBy: "origin",
        limit: 10,
      })) as {
        meta: {
          surrounding: number;
        };
        groups: Array<{
          source: string;
          time?: string;
          score?: number;
          ts?: number;
          origin?: { kind: string; sessionId?: string; label?: string; filePath?: string };
          entries: Array<
            Array<{
              kind: string;
              text: string;
              time?: string;
              matched?: boolean;
              requestId?: string;
              author?: string;
              score?: number;
              ts?: number;
            }>
          >;
        }>;
      };

      expect(result.meta.surrounding).toBe(1);

      const conversationGroup = result.groups.find(
        (group) => group.source === "conversation" && group.origin?.sessionId === "c1",
      );
      expect(conversationGroup).toBeDefined();
      expect(conversationGroup?.origin?.label).toBe("ops");
      expect(typeof conversationGroup?.time).toBe("string");
      expect(Object.prototype.hasOwnProperty.call(conversationGroup ?? {}, "score")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(conversationGroup ?? {}, "ts")).toBe(false);
      expect(conversationGroup?.entries).toHaveLength(1);
      expect(conversationGroup?.entries[0]?.map((entry) => entry.text)).toEqual([
        "start release prep",
        "deploy completed successfully",
        "post deploy checklist pending",
      ]);
      expect(conversationGroup?.entries[0]?.[1]?.author).toBe("releaseCaptain (bob; u2)");
      expect(typeof conversationGroup?.entries[0]?.[1]?.time).toBe("string");
      expect(
        Object.prototype.hasOwnProperty.call(conversationGroup?.entries[0]?.[1] ?? {}, "score"),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(conversationGroup?.entries[0]?.[1] ?? {}, "ts"),
      ).toBe(false);
      expect(
        (conversationGroup?.entries[0]?.filter((entry) => entry.matched).length ?? 0) >= 1,
      ).toBe(true);

      const transcriptOnlyGroup = result.groups.find(
        (group) => group.source === "conversation" && group.origin?.sessionId === "c3",
      );
      expect(transcriptOnlyGroup?.entries[0]?.[0]?.requestId).toBe("req-orphan");

      const githubTranscriptGroup = result.groups.find(
        (group) => group.source === "conversation" && group.origin?.sessionId === "owner/repo#12",
      );
      expect(githubTranscriptGroup?.entries[0]?.[0]?.requestId).toBe("req-github");

      const duplicateTranscript = result.groups.find(
        (group) =>
          group.source === "conversation" &&
          group.entries.some((window) => window.some((entry) => entry.requestId === "req-surface")),
      );
      expect(duplicateTranscript).toBeUndefined();

      const indexedConversationSources = new Database(path.join(fixture.root, "discovery.db"));
      try {
        expect(
          indexedConversationSources
            .query<{ doc_key: string; kind: string }, []>(
              `SELECT doc_key, kind
               FROM discovery_documents
               WHERE doc_key IN (
                 'conversation:surface:discord:c1:m2',
                 'conversation:transcript:discord:c1:req-surface',
                 'conversation:transcript:github:owner/repo#12:req-github'
               )
               ORDER BY doc_key`,
            )
            .all(),
        ).toEqual([
          {
            doc_key: "conversation:surface:discord:c1:m2",
            kind: "surface_message",
          },
          {
            doc_key: "conversation:transcript:github:owner/repo#12:req-github",
            kind: "transcript_request",
          },
        ]);
      } finally {
        indexedConversationSources.close();
      }

      const fileGroups = result.groups.filter((group) => group.origin?.kind === "file");
      expect(fileGroups.length).toBeGreaterThan(0);
      expect(
        fileGroups.some((group) => group.origin?.filePath?.endsWith("MEMORY.md") === true),
      ).toBe(true);
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("supports lookback windows and time ordering", async () => {
    const fixture = await makeFixture();

    try {
      const result = (await fixture.tool.call("discovery.search", {
        query: "deploy",
        sources: ["conversation"],
        orderBy: "time",
        direction: "desc",
        groupBy: "none",
        lookbackTime: "1d",
        offsetTime: 0,
        limit: 10,
        verbose: true,
      })) as {
        meta: {
          window?: {
            startTime: string;
            endTime: string;
            startTs?: number;
            endTs?: number;
          };
        };
        groups: Array<{
          ts?: number;
          time?: string;
          origin?: { sessionId?: string };
        }>;
      };

      expect(result.groups.every((group) => group.origin?.sessionId !== "c2")).toBe(true);
      expect(["c3", "owner/repo#12"]).toContain(result.groups[0]?.origin?.sessionId ?? "");
      expect(typeof result.groups[0]?.time).toBe("string");
      expect((result.groups[0]?.ts ?? 0) >= (result.groups[1]?.ts ?? 0)).toBe(true);
      expect(result.meta.window?.startTs).toBeDefined();
      expect(result.meta.window?.endTs).toBeDefined();
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("rejects invalid time windows with owned input failures", async () => {
    const fixture = await makeFixture();

    try {
      const invalidResult = await fixture.discoveryService.searchResult({
        query: "deploy",
        offsetTime: "1h",
      });
      expect(invalidResult.status).toBe("error");
      if (invalidResult.status === "error") {
        expect(invalidResult.error).toMatchObject({
          _tag: "DiscoverySearchInputError",
          field: "offsetTime",
        });
      }
      await expect(
        fixture.discoveryService.search({ query: "deploy", offsetTime: "1h" }),
      ).rejects.toMatchObject({ _tag: "DiscoverySearchInputError", field: "offsetTime" });
      await expect(
        fixture.discoveryService.search({ query: "deploy", lookbackTime: "invalid" }),
      ).rejects.toMatchObject({ _tag: "DiscoverySearchInputError", field: "lookbackTime" });
      await expect(fixture.discoveryService.search({ query: "  " })).rejects.toMatchObject({
        _tag: "DiscoverySearchInputError",
        field: "query",
      });
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("captures discovery dependency rejection and closes through typed Results", async () => {
    const fixture = await makeFixture();
    const cause = new Error("config unavailable");
    const failingService = new DiscoveryService({
      dbPath: path.join(fixture.root, "failing-discovery.db"),
      dataDir: fixture.dataDir,
      getConfig: async () => Promise.reject(cause),
    });

    try {
      const searched = await failingService.searchResult({ query: "deploy", sources: ["prompt"] });
      expect(searched.status).toBe("error");
      if (searched.status === "error") {
        expect(searched.error).toMatchObject({
          _tag: "DiscoverySearchOperationError",
          cause,
        });
      }
    } finally {
      expect(failingService.closeResult().status).toBe("ok");
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("filters conversation search by platform, session, and author", async () => {
    const fixture = await makeFixture();

    try {
      const byAuthor = (await fixture.tool.call("discovery.search", {
        query: "deploy",
        sources: ["conversation", "prompt", "heartbeat"],
        authorId: "u2",
        groupBy: "origin",
        limit: 10,
      })) as {
        meta: { authorId?: string };
        groups: Array<{
          origin?: { kind: string; platform?: string; sessionId?: string };
          entries: Array<Array<{ text: string; matched?: boolean; author?: string }>>;
        }>;
      };

      expect(byAuthor.meta.authorId).toBe("u2");
      expect(byAuthor.groups).toHaveLength(1);
      expect(byAuthor.groups[0]?.origin).toMatchObject({
        kind: "session",
        platform: "discord",
        sessionId: "c1",
      });
      expect(byAuthor.groups[0]?.entries[0]?.map((entry) => entry.text)).toEqual([
        "start release prep",
        "deploy completed successfully",
        "post deploy checklist pending",
      ]);
      expect(
        byAuthor.groups[0]?.entries[0]
          ?.filter((entry) => entry.matched)
          .map((entry) => entry.author),
      ).toEqual(["releaseCaptain (bob; u2)"]);

      const byPlatform = (await fixture.tool.call("discovery.search", {
        query: "deploy",
        platform: "github",
        groupBy: "none",
        limit: 10,
      })) as {
        meta: { platform?: string };
        groups: Array<{
          origin?: { kind: string; platform?: string; sessionId?: string; filePath?: string };
        }>;
      };

      expect(byPlatform.meta.platform).toBe("github");
      expect(byPlatform.groups).toHaveLength(1);
      expect(byPlatform.groups[0]?.origin).toMatchObject({
        kind: "session",
        platform: "github",
        sessionId: "owner/repo#12",
      });

      const bySession = (await fixture.tool.call("discovery.search", {
        query: "deploy",
        sessionId: "c3",
        groupBy: "none",
        limit: 10,
      })) as {
        meta: { sessionId?: string };
        groups: Array<{
          origin?: { kind: string; platform?: string; sessionId?: string; filePath?: string };
          entries: Array<Array<{ text: string }>>;
        }>;
      };

      expect(bySession.meta.sessionId).toBe("c3");
      expect(bySession.groups).toHaveLength(1);
      expect(bySession.groups[0]?.origin).toMatchObject({
        kind: "session",
        platform: "discord",
        sessionId: "c3",
      });
      expect(bySession.groups[0]?.entries[0]?.[0]?.text).toBe(
        "deploy retrospective summary followup",
      );

      const unknownAuthor = (await fixture.tool.call("discovery.search", {
        query: "deploy",
        authorId: "missing-user",
        limit: 10,
      })) as { groups: unknown[] };

      expect(unknownAuthor.groups).toHaveLength(0);
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("applies limit after origin grouping", async () => {
    const fixture = await makeFixture();

    try {
      const result = (await fixture.tool.call("discovery.search", {
        query: "deploy",
        sources: ["conversation", "prompt", "heartbeat"],
        groupBy: "origin",
        limit: 2,
      })) as {
        groups: Array<{
          origin?: { kind: string; sessionId?: string; filePath?: string };
        }>;
      };

      expect(result.groups.length).toBe(2);
      const uniqueOrigins = new Set(
        result.groups.map(
          (group) => group.origin?.sessionId ?? group.origin?.filePath ?? "missing",
        ),
      );
      expect(uniqueOrigins.size).toBe(2);
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("accepts scalar source shorthand", async () => {
    const fixture = await makeFixture();

    try {
      const result = (await fixture.tool.call("discovery.search", {
        query: "deploy",
        sources: "conversation",
        limit: 10,
      })) as {
        meta: { sources: string[] };
        groups: Array<{ source: string }>;
      };

      expect(result.meta.sources).toEqual(["conversation"]);
      expect(result.groups.every((group) => group.source === "conversation")).toBe(true);
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("renders source array help clearly", async () => {
    const fixture = await makeFixture();

    try {
      const entry = (await fixture.tool.list()).find(
        (item) => item.callableId === "discovery.search",
      );
      expect(entry?.input?.find((line) => line.startsWith("--sources="))).toContain(
        '("conversation" | "prompt" | "heartbeat")[]',
      );
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("returns guided validation errors for invalid input", async () => {
    const fixture = await makeFixture();

    try {
      const result = await fixture.tool.callResult("discovery.search", {
        query: "deploy",
        sources: "missing",
      });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.kind).toBe("usage");
        expect(result.error.message).toContain("discovery.search has invalid input.");
      }
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("declares query as the primary positional argument", async () => {
    const fixture = await makeFixture();

    try {
      const entry = (await fixture.tool.list()).find(
        (item) => item.callableId === "discovery.search",
      );
      expect(entry?.primaryPositional?.field).toBe("query");
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });

  it("includes the year in formatted time for non-current-year hits", async () => {
    const fixture = await makeFixture();

    try {
      const result = (await fixture.tool.call("discovery.search", {
        query: "annual archive note",
        sources: ["conversation"],
        groupBy: "none",
        limit: 1,
      })) as {
        groups: Array<{
          entries: Array<Array<{ time?: string }>>;
        }>;
      };

      expect(result.groups[0]?.entries[0]?.[0]?.time).toContain(
        String(new Date().getFullYear() - 1),
      );
    } finally {
      fixture.discoveryService.close();
      fixture.discordSearchStore.close();
      fixture.transcriptStore.close();
    }
  });
});
