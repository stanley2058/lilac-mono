import { join } from "node:path";
import Redis from "ioredis";
import { Result } from "better-result";
import { z } from "zod";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";
import {
  blobRefV1Schema,
  createLocalBlobStore,
  materializeBlobRead,
} from "@stanley2058/lilac-blob-storage";
import {
  createLilacBus,
  createRedisStreamsBus,
  lilacEventTypes,
  outReqTopic,
} from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import type { BuiltLevel1Toolset, CoreToolPluginManager } from "../../../../src/plugins";
import { SqliteTranscriptStore } from "../../../../src/transcript/transcript-store";
import { SqliteAgentRunJournal } from "../../../../src/surface/bridge/agent-run-journal";
import { startBusAgentRunner } from "../../../../src/surface/bridge/bus-agent-runner";
import {
  RequestDeliveryCoordinator,
  SqliteRequestDeliveryStore,
  coreRequestDeliveryCodecs,
  createCoreRequestDeliveryAdmission,
  createDurableCoreRequestBus,
  createLilacBusRequestDeliveryPublisher,
  createRequestDeliveryPostCommitObserver,
} from "../../../../src/surface/bridge/request-delivery";
import {
  joinAgentRunRecoveryHeads,
  removeFullyReconciledAgentRunTerminalHeads,
  selectAgentRunAcceptedRecovery,
} from "../../../../src/runtime/create-core-runtime";

const options = z
  .object({
    directory: z.string(),
    keyPrefix: z.string(),
    redisUrl: z.string(),
    requestId: z.string(),
    deliveryId: z.uuid(),
    phase: z.enum(["prepared", "published", "accepted", "output-persisted", "completed"]),
    recover: z.boolean(),
  })
  .parse(JSON.parse(process.argv[2]!));

const networkFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    input === "https://models.dev/api.json"
      ? Promise.resolve(new Response(null, { status: 503 }))
      : networkFetch(input, init),
  { preconnect: networkFetch.preconnect },
);

const redis = new Redis(options.redisUrl);
const raw = createRedisStreamsBus({ redis, keyPrefix: options.keyPrefix });
const blobs = (await createLocalBlobStore({ root: join(options.directory, "blobs") })).unwrap();
const transcripts = new SqliteTranscriptStore(join(options.directory, "transcripts.sqlite"));
const dbPath = join(options.directory, "request-delivery.sqlite");
const store = new SqliteRequestDeliveryStore({ dbPath, codecs: coreRequestDeliveryCodecs });
const journal = new SqliteAgentRunJournal({ dbPath });
const coordinator = new RequestDeliveryCoordinator({
  store,
  blobStore: blobs,
  admission: createCoreRequestDeliveryAdmission(blobs),
  inputBlobRetained: (objectId) =>
    transcripts.readCoreOwnedBlob(objectId).map((blob) => blob !== null),
});
const busTransport = createLilacBus(raw, {
  postCommitObserver: createRequestDeliveryPostCommitObserver({
    observeTransportCommit: (id, streamId) => coordinator.observeTransportCommit(id, streamId),
  }),
  reportFatal: {
    report: (error) => {
      throw error;
    },
  },
});
const publisher = createLilacBusRequestDeliveryPublisher(busTransport);
let modelCalls = 0;

async function barrier(phase: typeof options.phase): Promise<void> {
  if (options.recover || phase !== options.phase) return;
  const record = store.load(options.deliveryId).unwrap();
  const heads = journal.loadRecoveryHeads().unwrap();
  process.send?.({
    kind: "barrier",
    phase,
    pid: process.pid,
    state: record.state,
    terminalHead: heads.heads.some((head) => head.state === "terminal"),
    modelCalls,
  });
  await new Promise<void>(() => {});
}

const bus = createDurableCoreRequestBus({
  transportBus: busTransport,
  coordinator,
  publisher: {
    ...publisher,
    async acquire(input) {
      await barrier("prepared");
      return publisher.acquire(input);
    },
    async publish(input) {
      const result = await publisher.publish(input);
      result.unwrap();
      await barrier("published");
      return result;
    },
  },
});
const terminalize = coordinator.terminalize.bind(coordinator);
coordinator.terminalize = async (input) => {
  await barrier("output-persisted");
  return terminalize(input);
};

const toolset: BuiltLevel1Toolset = {
  tools: {},
  specs: new Map(),
  contributionInfo: new Map(),
  directToolNames: new Set(),
  catalog: [],
  catalogMetadata: {},
  genericOutputNormalizerBypassTools: new Set(),
  aggregateOutputBudgetExemptTools: new Set(),
  release: async () => Result.ok(undefined),
};
const manager: CoreToolPluginManager = {
  init: async () => Result.ok(undefined),
  destroy: async () => Result.ok(undefined),
  reload: async () => Result.ok(undefined),
  ensureFresh: async () => Result.ok(undefined),
  getStatuses: () => [],
  getLevel2Tools: () => [],
  getLevel2ContributionInfo: () => new Map(),
  buildLevel1ToolsetResult: async () => Result.ok(toolset),
};
const config = parseCoreConfigV2ToUniversal({ agent: { retry: { enabled: false } } });
config.models.main = { model: "openai/process-crash-test" };

if (!options.recover) {
  const ingress = (
    await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId: "process-crash",
        startFrom: "beginning",
      },
      async () => {
        throw new Error("No producer may publish before the durable queue exists");
      },
      () => "stop",
    )
  ).unwrap();
  (await ingress.stop()).unwrap();
  (await ingress.done).unwrap();
  const upload = (
    await blobs.startUpload({
      source: new TextEncoder().encode("retained process attachment"),
      retention: { kind: "durable" },
    })
  ).unwrap();
  const reference = (await upload.completion).unwrap();
  await Bun.write(join(options.directory, "attachment.json"), JSON.stringify(reference));
  (
    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: options.deliveryId,
        queue: "prompt",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Read the attachment and respond" },
              { type: "blob", blob: upload.handle, mediaType: "text/plain", filename: "input.txt" },
            ],
          },
        ],
      },
      {
        headers: {
          request_id: options.requestId,
          session_id: options.requestId,
          request_client: "github",
        },
      },
    )
  ).unwrap();
} else {
  const recovered = (await coordinator.recoverPreparedPublications(publisher)).unwrap();
  if (recovered.failures.length || recovered.ambiguous)
    throw new Error("Prepared request did not recover");
}

const recovery = joinAgentRunRecoveryHeads({
  heads: journal.loadRecoveryHeads().unwrap().heads,
  requestDeliveryStore: store,
  journal,
  logger: { warn: () => undefined },
});
const runner = await startBusAgentRunner({
  bus,
  blobStore: blobs,
  requestDelivery: coordinator,
  agentRunJournal: journal,
  transcriptStore: transcripts,
  subscriptionId: "process-crash",
  startPaused: true,
  config,
  pluginManager: manager,
  cwd: options.directory,
  issueControlCapability: () => ({ capability: "process-test", principal: null }),
  reportFatalPanic: (error) => {
    throw error;
  },
  createAgent: (agentOptions) =>
    new AiSdkPiAgent({
      ...agentOptions,
      model: new MockLanguageModelV4({
        doStream: async () => {
          modelCalls += 1;
          await barrier("accepted");
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "text-start", id: "text" },
                { type: "text-delta", id: "text", delta: "Recovered answer" },
                { type: "text-end", id: "text" },
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ],
            }),
          };
        },
      }),
    }),
});
const accepted = (
  await coordinator.recoverAccepted(
    (record) => {
      const decision = selectAgentRunAcceptedRecovery(recovery, record.requestDeliveryId);
      return decision.kind === "retained-active"
        ? Promise.resolve(Result.ok(undefined))
        : runner.resumeAcceptedDelivery(
            record,
            decision.kind === "resume" ? decision.head : undefined,
          );
    },
    {
      terminalRecovery: (record) => {
        const decision = selectAgentRunAcceptedRecovery(recovery, record.requestDeliveryId);
        if (decision.kind !== "terminal") return undefined;
        return { outcome: decision.outcome, finalReplayDeadline: decision.finalReplayDeadline };
      },
      prepareTerminalRecovery: (record) =>
        Promise.resolve(runner.discardPausedRecoveredDelivery(record.requestDeliveryId)),
    },
  )
).unwrap();
if (accepted.failures.length) throw new Error("Accepted request did not recover");
removeFullyReconciledAgentRunTerminalHeads({
  heads: recovery.heads,
  requestDeliveryStore: store,
  journal,
});
runner.activate();
const deadline = Date.now() + 10_000;
while (store.load(options.deliveryId).unwrap().state !== "terminal") {
  if (Date.now() >= deadline)
    throw new Error(
      `Request did not settle after process restart: ${store.load(options.deliveryId).unwrap().state}, model calls ${modelCalls}`,
    );
  await new Promise<void>((resolve) => setImmediate(resolve));
}
await runner.waitForIdle();
await barrier("completed");

const ref = blobRefV1Schema.parse(
  await Bun.file(join(options.directory, "attachment.json")).json(),
);
const read = (await blobs.open(ref)).unwrap();
const bytes = (await materializeBlobRead(read)).unwrap();
const outputs = (
  await bus.fetchTopic(outReqTopic(options.requestId), { offset: { type: "begin" }, limit: 100 })
).unwrap();
const record = store.load(options.deliveryId).unwrap();
process.send?.({
  kind: "recovered",
  pid: process.pid,
  state: record.state,
  modelCalls,
  attachment: new TextDecoder().decode(bytes),
  finalOutputs: outputs.messages
    .filter(({ msg }) => msg.type === lilacEventTypes.EvtAgentOutputResponseText)
    .map(({ msg }) => msg.data),
  transcript: transcripts.getRequestTranscript({ requestId: options.requestId }).unwrap()
    ?.finalText,
  recoveryResumed: accepted.resumed,
  recoveryTerminalized: accepted.terminalized,
});
await runner.stop();
(await bus.close()).unwrap();
journal.close();
store.close();
transcripts.close();
(await blobs.close({ deadlineAtMs: Date.now() + 1_000 })).unwrap();
await redis.quit();
process.disconnect?.();
