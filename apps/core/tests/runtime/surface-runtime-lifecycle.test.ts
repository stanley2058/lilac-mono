import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import { scheduleCoreBlobStoreClose } from "../../src/runtime/create-core-runtime";
import {
  connectAndValidateSurfaceAdapters,
  createSurfaceWorkflowProgressPortMap,
  disconnectSurfaceAdapters,
  startSurfaceAdapterIngress,
  startSurfaceOutputs,
  stopIngressAndDrainSurfaces,
  stopSurfaceAdapterIngress,
  stopSurfaceOutputs,
  stopSurfaceRequestIngress,
  type ConnectedSurfaceAdapters,
  type SurfaceAdapterIngressHandles,
  type SurfaceRelayHandles,
  type SurfaceRequestIngressHandles,
} from "../../src/runtime/surface-runtime-lifecycle";
import type {
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOutputStream,
  SurfaceSendPreparationInput,
} from "../../src/surface/adapter";
import {
  createDiscordRelayPolicy,
  createDiscordSurfaceRuntimeDescriptor,
} from "../../src/surface/discord/discord-runtime-descriptor";
import {
  createGithubRelayPolicy,
  createGithubSurfaceRuntimeDescriptor,
} from "../../src/surface/github/github-runtime-descriptor";
import {
  SurfaceRuntimeRegistry,
  type SurfaceRelayHandle,
} from "../../src/surface/runtime-descriptor";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfacePlatform,
  SurfaceSelf,
} from "../../src/surface/types";

class TestAdapter implements SurfaceAdapter {
  constructor(
    private readonly platform: SurfacePlatform,
    private readonly calls: string[],
    private readonly connectFailure?: Error,
  ) {}

  async connect(): Promise<void> {
    this.calls.push(`${this.platform}-connect`);
    if (this.connectFailure) throw this.connectFailure;
  }

  async disconnect(): Promise<void> {
    this.calls.push(`${this.platform}-disconnected`);
  }

  async getSelf(): Promise<SurfaceSelf> {
    this.calls.push(`${this.platform}-validate`);
    return { platform: this.platform, userId: "bot", userName: "bot" };
  }

  async listSessions() {
    return Result.ok([]);
  }
  async listSessionParticipants() {
    return Result.ok({ source: "guild_members" as const, participants: [] });
  }

  async startOutput(_sessionRef: SessionRef, _opts?: StartOutputOpts) {
    return Result.ok({
      push: async () => Result.ok("visible" as const),
      finish: async () =>
        Result.ok({
          created: [{ platform: "discord", channelId: "channel", messageId: "message" }],
          last: { platform: "discord", channelId: "channel", messageId: "message" },
        }),
      abort: async () => Result.ok(undefined),
    } satisfies SurfaceOutputStream);
  }
  async startTyping() {
    return Result.ok({ stop: async () => Result.ok(undefined) });
  }

  async prepareSendMsg(
    _sessionRef: SessionRef,
    _input: SurfaceSendPreparationInput,
    _opts?: SendOpts,
  ) {
    return Result.ok(undefined);
  }

  async sendMsg(sessionRef: SessionRef, _content: ContentOpts, _opts?: SendOpts) {
    return Result.ok({
      platform: "discord" as const,
      channelId: sessionRef.channelId,
      messageId: "message",
    });
  }

  async readMsg(_msgRef: MsgRef) {
    return Result.ok(null);
  }

  async listMsg(_sessionRef: SessionRef, _opts?: LimitOpts) {
    return Result.ok([]);
  }

  async editMsg(_msgRef: MsgRef, _content: ContentOpts) {
    return Result.ok(undefined);
  }

  async deleteMsg(_msgRef: MsgRef) {
    return Result.ok(undefined);
  }

  async getReplyContext(_msgRef: MsgRef, _opts?: LimitOpts) {
    return Result.ok([]);
  }
  async planReplyChain(msgRef: MsgRef) {
    return Result.ok([msgRef]);
  }
  async planMergeBlockEndingAt(msgRef: MsgRef) {
    return Result.ok([msgRef]);
  }

  async addReaction(_msgRef: MsgRef, _reaction: string) {
    return Result.ok(undefined);
  }

  async removeReaction(_msgRef: MsgRef, _reaction: string) {
    return Result.ok(undefined);
  }

  async listReactions(_msgRef: MsgRef) {
    return Result.ok([]);
  }
  async listReactionDetails(_msgRef: MsgRef) {
    return Result.ok([]);
  }

  async getUnRead(_sessionRef: SessionRef) {
    return Result.ok([]);
  }

  async markRead(_sessionRef: SessionRef, _upToMsgRef?: MsgRef) {
    return Result.ok(undefined);
  }
}

function emptyRelayHandle<P extends "discord" | "github">(
  platform: P,
  stop: () => Promise<void> = async () => undefined,
): SurfaceRelayHandle<P> {
  return {
    platform,
    beginDrain: async () => undefined,
    stop,
  };
}

function createRegistry(input: {
  readonly calls: string[];
  readonly discordAdapter?: SurfaceAdapter;
  readonly githubAdapter?: SurfaceAdapter;
  readonly adapterIngressStart?: () => Promise<{
    readonly platform: "discord";
    stop(): Promise<void>;
  }>;
  readonly discordRelayStart?: () => Promise<SurfaceRelayHandle<"discord">>;
  readonly githubRequestIngressStart?: () => Promise<{ stop(): Promise<void> }>;
  readonly githubRelayStart?: () => Promise<SurfaceRelayHandle<"github">>;
}): SurfaceRuntimeRegistry {
  const discordAdapter = input.discordAdapter ?? new TestAdapter("discord", input.calls);
  const githubAdapter = input.githubAdapter ?? new TestAdapter("github", input.calls);
  const githubRelayStart = input.githubRelayStart;
  const created = SurfaceRuntimeRegistry.create([
    createDiscordSurfaceRuntimeDescriptor({
      adapter: discordAdapter,
      getConfig: async () => parseCoreConfigV2ToUniversal({}),
      adapterIngress: {
        start:
          input.adapterIngressStart ??
          (async () => ({ platform: "discord", stop: async () => undefined })),
      },
      createRelay: (guardedAdapter) => ({
        ...createDiscordRelayPolicy(guardedAdapter),
        lifecycle: {
          platform: "discord",
          start: input.discordRelayStart ?? (async () => emptyRelayHandle("discord")),
        },
      }),
    }),
    createGithubSurfaceRuntimeDescriptor({
      adapter: githubAdapter,
      ...(input.githubRequestIngressStart
        ? { requestIngress: { start: input.githubRequestIngressStart } }
        : {}),
      ...(githubRelayStart
        ? {
            createRelay: () => ({
              ...createGithubRelayPolicy(),
              lifecycle: { platform: "github" as const, start: githubRelayStart },
            }),
          }
        : {}),
    }),
  ]);
  if (created.status === "error") throw created.error;
  return created.value;
}

function maps() {
  return {
    connected: new Map() as ConnectedSurfaceAdapters,
    adapterIngress: new Map() as SurfaceAdapterIngressHandles,
    requestIngress: new Map() as SurfaceRequestIngressHandles,
    relays: new Map() as SurfaceRelayHandles,
  };
}

describe("surface runtime lifecycle", () => {
  it("starts the absolute blob fence while a producer stop remains hung", async () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    const producerStopEntered = Promise.withResolvers<void>();
    const releaseProducerStop = Promise.withResolvers<void>();
    const blobCloseStarted = Promise.withResolvers<void>();
    let deadlineCallback = (): void => {
      throw new Error("Blob close deadline was not scheduled");
    };
    let closeCount = 0;
    const closeController = scheduleCoreBlobStoreClose({
      hardDeadlineAtMs: 6_000,
      now: () => 1_000,
      close: async () => {
        closeCount += 1;
        blobCloseStarted.resolve();
      },
      scheduleDeadline: (callback, delayMs) => {
        expect(delayMs).toBe(4_000);
        deadlineCallback = callback;
        return () => undefined;
      },
    });
    let drainSettled = false;
    const draining = stopIngressAndDrainSurfaces({
      registry,
      stopAdapterIngress: async () => undefined,
      stopRouterIngress: async () => {
        producerStopEntered.resolve();
        await releaseProducerStop.promise;
      },
      stopWorkflowRequestProducers: async () => undefined,
      stopRequestIngress: async () => undefined,
      stopRemainingRequestProducers: async () => undefined,
      deadlineMs: 3_000,
      runCleanup: async (_label, cleanup) => cleanup?.(),
      agentRunner: { beginDrain: async () => undefined },
      relays: handles.relays,
    }).then(() => {
      drainSettled = true;
    });

    await producerStopEntered.promise;
    deadlineCallback();
    await blobCloseStarted.promise;

    expect(drainSettled).toBe(false);
    expect(closeCount).toBe(1);

    releaseProducerStop.resolve();
    await draining;
    await closeController.closeNow();
    expect(closeCount).toBe(1);
  });

  it("derives workflow progress ports from unique registry entries", () => {
    const calls: string[] = [];
    const registry = createRegistry({
      calls,
      githubRequestIngressStart: async () => ({ stop: async () => undefined }),
    });
    const ports = createSurfaceWorkflowProgressPortMap(registry);
    const [discord, github] = registry.entries();
    if (!discord?.workflowProgress || !github?.workflowProgress) {
      throw new Error("Missing expected workflow progress ports");
    }

    const discordRegistration = ports.get("discord");
    const githubRegistration = ports.get("github");
    expect(discordRegistration?.platform).toBe("discord");
    expect(discordRegistration?.protocol).toBe(discord.protocol);
    expect(discordRegistration?.port).toBe(discord.workflowProgress);
    expect(githubRegistration?.platform).toBe("github");
    expect(githubRegistration?.protocol).toBe(github.protocol);
    expect(githubRegistration?.port).toBe(github.workflowProgress);
  });

  it("preserves adapter ingress, connection, validation, and output activation phases", async () => {
    const calls: string[] = [];
    const registry = createRegistry({
      calls,
      adapterIngressStart: async () => {
        calls.push("discord-adapter-ingress");
        return { platform: "discord", stop: async () => undefined };
      },
      discordRelayStart: async () => {
        calls.push("discord-relay");
        return emptyRelayHandle("discord");
      },
      githubRequestIngressStart: async () => {
        calls.push("github-request-ingress");
        return { stop: async () => undefined };
      },
      githubRelayStart: async () => {
        calls.push("github-relay");
        return emptyRelayHandle("github");
      },
    });
    const handles = maps();

    await startSurfaceAdapterIngress({ registry, handles: handles.adapterIngress });
    await connectAndValidateSurfaceAdapters({ registry, connected: handles.connected });
    await startSurfaceOutputs({
      registry,
      requestIngress: handles.requestIngress,
      relays: handles.relays,
    });

    expect(calls).toEqual([
      "discord-adapter-ingress",
      "discord-connect",
      "github-connect",
      "discord-validate",
      "github-validate",
      "discord-relay",
      "github-request-ingress",
      "github-relay",
    ]);
    expect([...handles.connected.keys()]).toEqual(["discord", "github"]);
    expect([...handles.adapterIngress.keys()]).toEqual(["discord"]);
    expect([...handles.requestIngress.keys()]).toEqual(["github"]);
    expect([...handles.relays.keys()]).toEqual(["discord", "github"]);
  });

  it.each([
    ["request ingress", true, false, ["discord-relay", "github-request-ingress"]],
    ["relay", false, true, ["discord-relay", "github-relay"]],
    ["neither", false, false, ["discord-relay"]],
  ] as const)("activates GitHub %s independently", async (_, requestIngress, relay, expected) => {
    const calls: string[] = [];
    const registry = createRegistry({
      calls,
      discordRelayStart: async () => {
        calls.push("discord-relay");
        return emptyRelayHandle("discord");
      },
      ...(requestIngress
        ? {
            githubRequestIngressStart: async () => {
              calls.push("github-request-ingress");
              return { stop: async () => undefined };
            },
          }
        : {}),
      ...(relay
        ? {
            githubRelayStart: async () => {
              calls.push("github-relay");
              return emptyRelayHandle("github");
            },
          }
        : {}),
    });
    const handles = maps();

    await startSurfaceOutputs({
      registry,
      requestIngress: handles.requestIngress,
      relays: handles.relays,
    });

    expect(calls).toEqual([...expected]);
  });

  it("retains only completed resources after partial output startup", async () => {
    const calls: string[] = [];
    const relayFailure = new Error("github relay failed");
    const registry = createRegistry({
      calls,
      discordRelayStart: async () => {
        calls.push("discord-relay-started");
        return emptyRelayHandle("discord", async () => {
          calls.push("discord-relay-stopped");
        });
      },
      githubRequestIngressStart: async () => {
        calls.push("github-ingress-started");
        return {
          stop: async () => {
            calls.push("github-ingress-stopped");
          },
        };
      },
      githubRelayStart: async () => {
        calls.push("github-relay-failed");
        throw relayFailure;
      },
    });
    const handles = maps();

    await expect(
      startSurfaceOutputs({
        registry,
        requestIngress: handles.requestIngress,
        relays: handles.relays,
      }),
    ).rejects.toBe(relayFailure);
    expect([...handles.relays.keys()]).toEqual(["discord"]);
    expect([...handles.requestIngress.keys()]).toEqual(["github"]);

    await stopSurfaceOutputs({
      registry,
      requestIngress: handles.requestIngress,
      relays: handles.relays,
      runCleanup: async (label, cleanup) => {
        calls.push(label);
        await cleanup?.();
      },
    });
    expect(calls).toEqual([
      "discord-relay-started",
      "github-ingress-started",
      "github-relay-failed",
      "surface.github.request-ingress.stop",
      "github-ingress-stopped",
      "surface.discord.relay.stop",
      "discord-relay-stopped",
    ]);
  });

  it("disconnects every adapter whose connection attempt may have acquired resources", async () => {
    const calls: string[] = [];
    const failure = new Error("github connect failed");
    const registry = createRegistry({
      calls,
      githubAdapter: new TestAdapter("github", calls, failure),
    });
    const handles = maps();

    await expect(
      connectAndValidateSurfaceAdapters({ registry, connected: handles.connected }),
    ).rejects.toBe(failure);
    await disconnectSurfaceAdapters({
      registry,
      connected: handles.connected,
      runCleanup: async (label, cleanup) => {
        calls.push(label);
        await cleanup?.();
      },
    });

    expect(calls).toEqual([
      "discord-connect",
      "github-connect",
      "surface.github.adapter.disconnect",
      "github-disconnected",
      "surface.discord.adapter.disconnect",
      "discord-disconnected",
    ]);
  });

  it("stops every ingress producer before draining the runner and relays", async () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    let now = 100;
    handles.relays.set("discord", {
      platform: "discord",
      beginDrain: async ({ deadlineMs }) => {
        calls.push(`relay:${deadlineMs}`);
      },
      stop: async () => undefined,
    });

    await stopIngressAndDrainSurfaces({
      stopAdapterIngress: async () => {
        calls.push("adapter-ingress");
        now += 1;
      },
      stopRouterIngress: async () => {
        calls.push("router-ingress");
        now += 1;
      },
      stopWorkflowRequestProducers: async () => {
        calls.push("workflow-producers");
        now += 1;
      },
      stopRequestIngress: async () => {
        calls.push("request-ingress");
        now += 1;
      },
      stopRemainingRequestProducers: async () => {
        calls.push("remaining-producers");
        now += 1;
      },
      registry,
      deadlineMs: 20,
      now: () => now,
      runCleanup: async (_label, cleanup) => cleanup?.(),
      agentRunner: {
        beginDrain: async ({ deadlineMs }) => {
          calls.push(`runner:${deadlineMs}`);
          now += 1;
        },
      },
      relays: handles.relays,
    });

    expect(calls).toEqual([
      "adapter-ingress",
      "router-ingress",
      "workflow-producers",
      "request-ingress",
      "remaining-producers",
      "runner:15",
      "relay:14",
    ]);
  });

  it("keeps draining relays when an earlier cleanup fails", async () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    handles.relays.set("discord", {
      platform: "discord",
      beginDrain: async ({ deadlineMs }) => {
        calls.push(`relay:${deadlineMs}`);
      },
      stop: async () => undefined,
    });

    await stopIngressAndDrainSurfaces({
      stopAdapterIngress: async () => undefined,
      stopRouterIngress: async () => undefined,
      stopWorkflowRequestProducers: async () => undefined,
      stopRequestIngress: async () => undefined,
      stopRemainingRequestProducers: async () => undefined,
      registry,
      deadlineMs: 20,
      now: () => 100,
      runCleanup: async (_label, cleanup) => {
        try {
          await cleanup?.();
        } catch {
          calls.push("failure");
        }
      },
      agentRunner: {
        beginDrain: async () => {
          throw new Error("runner drain failed");
        },
      },
      relays: handles.relays,
    });

    expect(calls).toEqual(["failure", "relay:20"]);
  });

  it("stops surface resources and disconnects adapters in reverse ownership order", async () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    for (const descriptor of registry.entries()) {
      handles.connected.set(descriptor.platform, descriptor.adapter);
    }
    handles.relays.set(
      "discord",
      emptyRelayHandle("discord", async () => {
        calls.push("discord-relay-stopped");
      }),
    );
    handles.relays.set(
      "github",
      emptyRelayHandle("github", async () => {
        calls.push("github-relay-stopped");
      }),
    );
    handles.requestIngress.set("github", {
      stop: async () => {
        calls.push("github-ingress-stopped");
      },
    });
    handles.adapterIngress.set("discord", {
      platform: "discord",
      stop: async () => {
        calls.push("discord-ingress-stopped");
      },
    });
    const runCleanup = async (label: string, cleanup: (() => Promise<void>) | undefined) => {
      calls.push(label);
      await cleanup?.();
    };

    await stopSurfaceOutputs({
      registry,
      requestIngress: handles.requestIngress,
      relays: handles.relays,
      runCleanup,
    });
    await stopSurfaceAdapterIngress({
      registry,
      handles: handles.adapterIngress,
      runCleanup,
      graceful: false,
    });
    await disconnectSurfaceAdapters({
      registry,
      connected: handles.connected,
      runCleanup,
    });

    expect(calls).toEqual([
      "surface.github.relay.stop",
      "github-relay-stopped",
      "surface.github.request-ingress.stop",
      "github-ingress-stopped",
      "surface.discord.relay.stop",
      "discord-relay-stopped",
      "surface.discord.adapter-ingress.stop",
      "discord-ingress-stopped",
      "surface.github.adapter.disconnect",
      "github-disconnected",
      "surface.discord.adapter.disconnect",
      "discord-disconnected",
    ]);
  });

  it("uses the graceful ingress cleanup labels and removes completed handles", async () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    handles.adapterIngress.set("discord", {
      platform: "discord",
      stop: async () => {
        calls.push("adapter-ingress-stopped");
      },
    });
    handles.requestIngress.set("github", {
      stop: async () => {
        calls.push("request-ingress-stopped");
      },
    });
    const runCleanup = async (label: string, cleanup: (() => Promise<void>) | undefined) => {
      calls.push(label);
      await cleanup?.();
    };

    await stopSurfaceAdapterIngress({
      registry,
      handles: handles.adapterIngress,
      runCleanup,
      graceful: true,
    });
    await stopSurfaceRequestIngress({
      registry,
      handles: handles.requestIngress,
      runCleanup,
      graceful: true,
    });

    expect(calls).toEqual([
      "graceful.surface.discord.adapter-ingress.stop",
      "adapter-ingress-stopped",
      "graceful.surface.github.request-ingress.stop",
      "request-ingress-stopped",
    ]);
    expect(handles.adapterIngress.size).toBe(0);
    expect(handles.requestIngress.size).toBe(0);
  });
});
