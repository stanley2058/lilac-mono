import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { describe, expect, it } from "bun:test";
import { createLilacBus } from "@stanley2058/lilac-event-bus";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { Panic, Result } from "better-result";

import { composeBuiltinSurfaceRuntimes } from "../../src/runtime/compose-builtin-surface-runtimes";
import type {
  AdapterEventHandler,
  SurfaceAdapter,
  SurfaceAdapterEventSource,
} from "../../src/surface/adapter";
import { createDescriptorBoundSurfaceEventSource } from "../../src/surface/produced-ref-guard";
import { nativeSurfaceProtocol } from "../../src/surface/native/native-protocol";
import type {
  SurfaceRuntimeDescriptor,
  SurfaceRuntimeHealthPort,
} from "../../src/surface/runtime-descriptor";
import { createInMemoryDeliveryBus } from "../helpers/in-memory-delivery-bus";

function createComposition(input: {
  readonly webhookSecret?: string;
  readonly githubAppCredentialsAvailable: boolean;
  readonly discordHealth?: SurfaceRuntimeHealthPort;
  readonly discordEnabled?: boolean;
  readonly nativeDescriptor?: SurfaceRuntimeDescriptor<"native">;
}) {
  const logs: Array<{
    readonly level: "debug" | "info" | "warn";
    readonly message: string;
    readonly context: Readonly<Record<string, unknown>>;
  }> = [];
  let adapterEventHandler: AdapterEventHandler | undefined;
  let transcriptStoreLookups = 0;
  const discordAdapter = {} as SurfaceAdapter;
  const githubAdapter = {} as SurfaceAdapter;
  const eventSource: SurfaceAdapterEventSource = {
    subscribe: async (handler) => {
      adapterEventHandler = handler;
      return { stop: async () => undefined };
    },
  };
  const created = composeBuiltinSurfaceRuntimes({
    discordAdapter,
    discordEnabled: input.discordEnabled,
    getConfig: async () => parseCoreConfigV2ToUniversal({}),
    nativeDescriptor: input.nativeDescriptor,
    githubAdapter,
    descriptorBoundDiscordEventSource: createDescriptorBoundSurfaceEventSource(
      "discord",
      eventSource,
    ),
    ...(input.discordHealth ? { discordHealth: input.discordHealth } : {}),
    bus: createLilacBus(createInMemoryDeliveryBus()),
    blobStore: {} as BlobStore,
    subscriptionPrefix: "focused",
    webhookSecret: input.webhookSecret,
    githubAppCredentialsAvailable: input.githubAppCredentialsAvailable,
    hasPublishedRequest: () => Result.ok(false),
    getTranscriptStore: () => {
      transcriptStoreLookups += 1;
      return undefined;
    },
    logger: {
      debug: (message, context) => logs.push({ level: "debug", message, context }),
      info: (message, context) => logs.push({ level: "info", message, context }),
      warn: (message, context) => logs.push({ level: "warn", message, context }),
    },
    reportFatalError: () => undefined,
  });
  if (created.status === "error") throw created.error;
  return {
    registry: created.value,
    discordAdapter,
    githubAdapter,
    logs,
    getAdapterEventHandler: () => adapterEventHandler,
    getTranscriptStoreLookups: () => transcriptStoreLookups,
  };
}

describe("built-in surface runtime composition", () => {
  it("runs native without registering Discord ingress, relay or questions", () => {
    const composition = createComposition({
      githubAppCredentialsAvailable: false,
      discordEnabled: false,
      nativeDescriptor: { protocol: nativeSurfaceProtocol, adapter: {} as SurfaceAdapter },
    });
    expect(composition.registry.entries().map((entry) => entry.platform)).toEqual([
      "native",
      "github",
    ]);
    expect(composition.registry.adapterResolver().resolve("discord")).toBeNull();
    expect(composition.registry.questionResolver().entries()).toHaveLength(0);
    const native = composition.registry.entries()[0]!;
    expect(native.relay).toBeUndefined();
    expect(native.adapterIngress).toBeUndefined();
  });
  it("registers optional Discord health without adding it to other descriptors", () => {
    const health: SurfaceRuntimeHealthPort = {
      getContribution: () => ({ checks: [], info: { ready: true } }),
    };
    const composition = createComposition({
      githubAppCredentialsAvailable: false,
      discordHealth: health,
    });
    const [discord, github] = composition.registry.entries();

    expect(discord?.health).toBe(health);
    expect(github?.health).toBeUndefined();
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    "preserves static order and GitHub webhook=%s/App credentials=%s availability",
    (webhookConfigured, githubAppCredentialsAvailable) => {
      const composition = createComposition({
        ...(webhookConfigured ? { webhookSecret: "webhook-secret" } : {}),
        githubAppCredentialsAvailable,
      });
      const [discord, github] = composition.registry.entries();
      if (!discord || !github) throw new Error("missing built-in surface descriptors");
      const requestIngressAvailable = webhookConfigured && githubAppCredentialsAvailable;

      expect(composition.registry.entries().map(({ platform }) => platform)).toEqual([
        "discord",
        "github",
      ]);
      expect(discord.adapter).not.toBe(composition.discordAdapter);
      expect(github.adapter).not.toBe(composition.githubAdapter);
      expect(discord.adapterIngress).toBeDefined();
      expect(discord.requestIngress).toBeUndefined();
      expect(discord.relay).toBeDefined();
      expect(github.requestIngress !== undefined).toBe(requestIngressAvailable);
      expect(github.relay !== undefined).toBe(githubAppCredentialsAvailable);
      expect(composition.logs).toEqual([
        ...(requestIngressAvailable
          ? []
          : [
              {
                level: "warn" as const,
                message: "GitHub webhook ingress unavailable",
                context: {
                  subsystem: "request-ingress",
                  reason: webhookConfigured ? "app-credentials-missing" : "webhook-secret-missing",
                },
              },
            ]),
        ...(githubAppCredentialsAvailable
          ? []
          : [
              {
                level: "info" as const,
                message: "GitHub output relay unavailable",
                context: {
                  subsystem: "output-relay",
                  reason: "app-credentials-missing",
                },
              },
            ]),
      ]);
    },
  );

  it.each([false, true])(
    "preserves Discord ingress and relay with native enabled=%s",
    async (nativeEnabled) => {
      const composition = createComposition({
        webhookSecret: "webhook-secret",
        githubAppCredentialsAvailable: true,
        ...(nativeEnabled
          ? { nativeDescriptor: { protocol: nativeSurfaceProtocol, adapter: {} as SurfaceAdapter } }
          : {}),
      });
      const entries = composition.registry.entries();
      const discord = entries.find((entry) => entry.platform === "discord");
      const github = entries.find((entry) => entry.platform === "github");
      expect(entries.some((entry) => entry.platform === "native")).toBe(nativeEnabled);
      if (!discord?.adapterIngress || !discord.relay || !github?.relay) {
        throw new Error("missing expected built-in runtime ports");
      }

      const ingress = await discord.adapterIngress.start();
      const eventHandler = composition.getAdapterEventHandler();
      if (!eventHandler) throw new Error("Discord event source was not subscribed");
      await eventHandler({
        type: "adapter.request.cancel",
        platform: "discord",
        ts: 1,
        requestId: "discord:channel:message",
        sessionId: "channel",
      });
      expect(() =>
        eventHandler({
          type: "adapter.request.cancel",
          platform: "github",
          ts: 2,
          requestId: "github:octo/repo#1:1",
          sessionId: "octo/repo#1",
        }),
      ).toThrow(Panic);

      const discordRelay = await discord.relay.lifecycle.start();
      const githubRelay = await github.relay.lifecycle.start();

      expect(composition.getTranscriptStoreLookups()).toBe(3);
      expect(composition.logs).toEqual([
        {
          level: "debug",
          message: "bridgeAdapterToBus started",
          context: { subscriptionId: "focused:adapter-to-bus" },
        },
        {
          level: "debug",
          message: "bridgeBusToAdapter started",
          context: { subscriptionId: "focused:bus-to-adapter" },
        },
        {
          level: "debug",
          message: "GitHub output relay started",
          context: { subscriptionId: "focused:bus-to-github" },
        },
      ]);

      await githubRelay.stop();
      await discordRelay.stop();
      await ingress.stop();
    },
  );
});
