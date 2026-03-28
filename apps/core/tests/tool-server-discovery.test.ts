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

  it("groups by origin, dedupes linked transcripts, and includes surrounding context", async () => {
    const fixture = await makeFixture();

    try {
      const result = (await fixture.tool.call("discovery.search", {
        query: "deploy",
        sources: ["conversation", "prompt", "heartbeat"],
        groupBy: "origin",
        surrounding: 1,
        limit: 10,
      })) as {
        groups: Array<{
          source: string;
          origin?: { kind: string; sessionId?: string; label?: string; filePath?: string };
          entries: Array<{
            kind: string;
            text: string;
            matched?: boolean;
            requestId?: string;
          }>;
        }>;
      };

      const conversationGroup = result.groups.find(
        (group) => group.source === "conversation" && group.origin?.sessionId === "c1",
      );
      expect(conversationGroup).toBeDefined();
      expect(conversationGroup?.origin?.label).toBe("ops");
      expect(conversationGroup?.entries.map((entry) => entry.text)).toEqual([
        "start release prep",
        "deploy completed successfully",
        "post deploy checklist pending",
      ]);
      expect((conversationGroup?.entries.filter((entry) => entry.matched).length ?? 0) >= 1).toBe(
        true,
      );

      const transcriptOnlyGroup = result.groups.find(
        (group) => group.source === "conversation" && group.origin?.sessionId === "c3",
      );
      expect(transcriptOnlyGroup?.entries[0]?.requestId).toBe("req-orphan");

      const githubTranscriptGroup = result.groups.find(
        (group) => group.source === "conversation" && group.origin?.sessionId === "owner/repo#12",
      );
      expect(githubTranscriptGroup?.entries[0]?.requestId).toBe("req-github");

      const duplicateTranscript = result.groups.find(
        (group) =>
          group.source === "conversation" &&
          group.entries.some((entry) => entry.requestId === "req-surface"),
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
      })) as {
        groups: Array<{
          ts?: number;
          origin?: { sessionId?: string };
        }>;
      };

      expect(result.groups.every((group) => group.origin?.sessionId !== "c2")).toBe(true);
      expect(result.groups[0]?.origin?.sessionId).toBe("c3");
      expect((result.groups[0]?.ts ?? 0) >= (result.groups[1]?.ts ?? 0)).toBe(true);
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
});
