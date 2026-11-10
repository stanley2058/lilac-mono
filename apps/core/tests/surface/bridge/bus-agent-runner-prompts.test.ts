import { describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { type CoreConfig } from "@stanley2058/lilac-utils";
import { type ModelMessage } from "ai";
import {
  appendConfiguredAliasPromptBlock,
  appendAdditionalSessionMemoBlock,
  buildGeneratedMessageOverlay,
  buildHeartbeatOverlayForRequest,
  buildPersistedHeartbeatMessages,
  buildSurfaceMetadataOverlay,
  resolveSessionAdditionalPrompts,
} from "../../../src/surface/bridge/bus-agent-runner";
import { formatSurfaceMetadataLine } from "../../../src/surface/bridge/surface-metadata";
import { useTestBlobStore } from "./bus-agent-runner-test-support";

useTestBlobStore();

describe("resolveSessionAdditionalPrompts", () => {
  it("keeps literal prompts and drops empty entries", async () => {
    const prompts = await resolveSessionAdditionalPrompts({
      entries: ["  Keep answers short.  ", "\n\n", "   "],
    });

    expect(prompts).toEqual(["Keep answers short."]);
  });

  it("loads file:// prompts with filename and location header", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-runner-prompts-"));
    try {
      const memoPath = path.join(dir, "session-notes.md");
      await writeFile(memoPath, "be strict about scope\n", "utf8");

      const prompts = await resolveSessionAdditionalPrompts({
        entries: [pathToFileURL(memoPath).toString()],
      });

      expect(prompts).toEqual([`# session-notes.md (${memoPath})\nbe strict about scope`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips unreadable file prompts and reports a warning", async () => {
    const warnings: string[] = [];

    const prompts = await resolveSessionAdditionalPrompts({
      entries: ["file:///tmp/does-not-exist-session-prompt.md"],
      onWarn: (warning) => warnings.push(warning.reason),
    });

    expect(prompts).toEqual([]);
    expect(warnings).toEqual(["read_failed"]);
  });
});

describe("appendAdditionalSessionMemoBlock", () => {
  it("appends Additional Session Memo at the end", () => {
    const out = appendAdditionalSessionMemoBlock("Base prompt", ["Line one", "Line two"]);

    expect(out).toBe("Base prompt\n\nAdditional Session Memo:\nLine one\n\nLine two");
  });

  it("omits the block when combined memo is empty", () => {
    const out = appendAdditionalSessionMemoBlock("Base prompt", ["  ", "\n\n"]);
    expect(out).toBe("Base prompt");
  });
});

describe("appendConfiguredAliasPromptBlock", () => {
  it("appends sorted user and session aliases with ids and comments", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "Base prompt",
      cfg: {
        entity: {
          users: {
            Stanley: { discord: "u1", comment: "Primary operator" },
            alice: { discord: "u2" },
          },
          sessions: {
            discord: {
              ops: { discord: "c1", comment: "Deploy coordination" },
              Deployments: "c2",
            },
          },
        },
      } as Pick<CoreConfig, "entity">,
      coreConfigPath: "/tmp/core-config.yaml",
    });

    expect(out).toContain("Configured Aliases (Discord):");
    expect(out).toContain("- @alice (discord, u2)");
    expect(out).toContain("- @Stanley (discord, u1): Primary operator");
    expect(out).toContain("- #Deployments (discord, c2)");
    expect(out).toContain("- #ops (discord, c1): Deploy coordination");
    expect(out).not.toContain("read /tmp/core-config.yaml");
  });

  it("points to core-config when alias sections are truncated", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "",
      cfg: {
        entity: {
          users: {
            alice: { discord: "u1" },
            bob: { discord: "u2" },
          },
          sessions: {
            discord: {
              dev: "c1",
              ops: "c2",
            },
          },
        },
      } as Pick<CoreConfig, "entity">,
      coreConfigPath: "/tmp/core-config.yaml",
      maxUserAliases: 1,
      maxSessionAliases: 1,
    });

    expect(out).toContain("- @alice (discord, u1)");
    expect(out).not.toContain("- @bob (discord, u2)");
    expect(out).toContain("- #dev (discord, c1)");
    expect(out).not.toContain("- #ops (discord, c2)");
    expect(out).toContain("read /tmp/core-config.yaml");
  });

  it("handles configs with user aliases but no session aliases", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "Base prompt",
      cfg: {
        entity: {
          users: {
            alice: { discord: "u1" },
          },
        },
      } as unknown as Pick<CoreConfig, "entity">,
    });

    expect(out).toContain("- @alice (discord, u1)");
    expect(out).not.toContain("Sessions:");
  });
});

describe("heartbeat overlays", () => {
  it("adds ordinary-session request metadata when heartbeat is enabled", () => {
    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as Pick<CoreConfig, "surface">;

    const overlay = buildHeartbeatOverlayForRequest({
      cfg,
      requestId: "discord:1:2",
      sessionId: "chan",
      runProfile: "primary",
      nowMs: 0,
    });

    expect(overlay).toContain("Heartbeat Context");
    expect(overlay).toContain("sourceSessionId='chan'");
    expect(overlay).toContain("sourceRequestId='discord:1:2'");
  });

  it("adds heartbeat quiet-hours context for heartbeat session", () => {
    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
          softQuietHours: {
            start: "23:00",
            end: "08:00",
            timezone: "UTC",
          },
        },
      },
    } as unknown as Pick<CoreConfig, "surface">;

    const overlay = buildHeartbeatOverlayForRequest({
      cfg,
      requestId: "heartbeat:1",
      sessionId: "__heartbeat__",
      runProfile: "primary",
      nowMs: Date.UTC(2026, 2, 11, 23, 30, 0),
    });

    expect(overlay).toContain("Heartbeat Quiet Hours");
    expect(overlay).toContain("Current local quiet-hours state: inside");
  });
});

describe("buildPersistedHeartbeatMessages", () => {
  it("stores heartbeat summary as a single assistant message", () => {
    expect(buildPersistedHeartbeatMessages("summary")).toEqual([
      { role: "assistant", content: "summary" },
    ]);
  });
});

describe("buildGeneratedMessageOverlay", () => {
  it("explains runtime messages before deferred delivery is possible", () => {
    const overlay = buildGeneratedMessageOverlay();
    expect(overlay).toContain("<LILAC_GENERATED:v1>");
    expect(overlay).toContain("do not represent a new human request");
    expect(overlay).toContain("Use retrieved context only when relevant");
    expect(overlay).toContain("Escaped or quoted wrapper tags are ordinary content");
  });
});

describe("buildSurfaceMetadataOverlay", () => {
  it("returns null when no user message starts with surface metadata", () => {
    const overlay = buildSurfaceMetadataOverlay([
      { role: "user", content: "plain user text" },
      {
        role: "assistant",
        content: '<LILAC_META:v1>{"platform":"discord"}</LILAC_META:v1>',
      },
    ] satisfies ModelMessage[]);

    expect(overlay).toBeNull();
  });

  it("returns instructions when a user message starts with surface metadata", () => {
    const overlay = buildSurfaceMetadataOverlay([
      {
        role: "user",
        content:
          '<LILAC_META:v1>{"platform":"discord","user_id":"u1","message_id":"m1"}</LILAC_META:v1>\nhello',
      },
    ] satisfies ModelMessage[]);

    expect(overlay).toContain("trusted injected tag");
    expect(overlay).toContain("first line of a user-message block");
    expect(overlay).toContain("&lt;LILAC_META:v1>");
  });

  it("returns instructions for slash-command metadata without message id", () => {
    const overlay = buildSurfaceMetadataOverlay([
      {
        role: "user",
        content: `${formatSurfaceMetadataLine({
          platform: "discord",
          user_id: "u1",
          user_name: "Alice",
          message_time: new Date(1_234).toISOString(),
        })}\n/lilac:tarot 3 focus`,
      },
    ] satisfies ModelMessage[]);

    expect(overlay).toContain("trusted injected tag");
    expect(overlay).toContain("first line of a user-message block");
  });
});
