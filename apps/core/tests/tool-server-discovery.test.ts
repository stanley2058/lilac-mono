import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { coreConfigSchema, ensurePromptWorkspace, type CoreConfig } from "@stanley2058/lilac-utils";

import { DiscoveryService } from "../src/discovery/discovery-service";
import { DiscordSearchStore } from "../src/surface/store/discord-search-store";
import { Discovery } from "../src/tool-server/tools/discovery";
import { SqliteTranscriptStore } from "../src/transcript/transcript-store";

function testConfig(input: unknown): CoreConfig {
  const cfg = coreConfigSchema.parse(input);
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

    const tool = new Discovery({ discovery: discoveryService });

    return {
      now,
      tool,
      discoveryService,
      discordSearchStore,
      transcriptStore,
    };
  }

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
