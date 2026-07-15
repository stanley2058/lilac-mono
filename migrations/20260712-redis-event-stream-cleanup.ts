import Redis from "../packages/event-bus/node_modules/ioredis";
import SuperJSON from "../packages/event-bus/node_modules/superjson";

// Dry run:
// REDIS_URL=redis://... bun migrations/20260712-redis-event-stream-cleanup.ts
// Apply after deploying fc24e98:
// REDIS_URL=redis://... bun migrations/20260712-redis-event-stream-cleanup.ts --apply --confirm-deployed-fc24e98
// Add --destroy-legacy-groups --confirm-no-legacy-processes only after replacing every old instance.

const OUTPUT_TTL_MS = 24 * 60 * 60 * 1000;
const SCAN_COUNT = 500;
const PENDING_BATCH_SIZE = 500;
const STALE_CONSUMER_IDLE_MS = 60 * 60 * 1000;
const REQUIRED_DEPLOY_CONFIRMATION = "--confirm-deployed-fc24e98";
const REQUIRED_LEGACY_PROCESS_CONFIRMATION = "--confirm-no-legacy-processes";
const LEGACY_EPHEMERAL_GROUP_PREFIXES = ["subagent:", "deferred-subagent:"] as const;
// These topics require application-owned durable checkpoints that this standalone migration
// cannot observe. Runtime reclamation combines those checkpoints with consumer-group frontiers.
const TAIL_REPLAY_TOPICS = new Set(["evt.request", "evt.adapter"]);

const TRIM_ACKNOWLEDGED_PREFIX_SCRIPT = `
local groups = redis.call("XINFO", "GROUPS", KEYS[1])
if #groups == 0 then return 0 end

local function component_less_than(left, right)
  if string.len(left) ~= string.len(right) then return string.len(left) < string.len(right) end
  return left < right
end

local function less_than(left, right)
  local left_dash = string.find(left, "-", 1, true)
  local right_dash = string.find(right, "-", 1, true)
  local left_time = string.sub(left, 1, left_dash - 1)
  local right_time = string.sub(right, 1, right_dash - 1)
  if left_time ~= right_time then return component_less_than(left_time, right_time) end
  local left_sequence = string.sub(left, left_dash + 1)
  local right_sequence = string.sub(right, right_dash + 1)
  return component_less_than(left_sequence, right_sequence)
end

local watermark = nil
for _, fields in ipairs(groups) do
  local name = nil
  local pending = nil
  local last_delivered_id = nil
  for index = 1, #fields, 2 do
    if fields[index] == "name" then name = fields[index + 1] end
    if fields[index] == "pending" then pending = fields[index + 1] end
    if fields[index] == "last-delivered-id" then last_delivered_id = fields[index + 1] end
  end
  if not name or pending == nil or not last_delivered_id then return 0 end

  local boundary = last_delivered_id
  if pending > 0 then
    local pending_summary = redis.call("XPENDING", KEYS[1], name)
    boundary = pending_summary[2]
    if not boundary then return 0 end
  end
  if boundary == "0-0" then return 0 end
  if not watermark or less_than(boundary, watermark) then watermark = boundary end
end

return redis.call("XTRIM", KEYS[1], "MINID", "=", watermark)
`;

const SET_OUTPUT_EXPIRY_IF_UNCHANGED_SCRIPT = `
if redis.call("TYPE", KEYS[1]).ok ~= "stream" then return 0 end
local info = redis.call("XINFO", "STREAM", KEYS[1])
local last_generated_id = nil
for index = 1, #info, 2 do
  if info[index] == "last-generated-id" then last_generated_id = info[index + 1] end
end
if last_generated_id ~= ARGV[1] then return 0 end
return redis.call("PEXPIREAT", KEYS[1], ARGV[2])
`;

type MigrationOptions = {
  apply: boolean;
  rewriteAof: boolean;
  destroyLegacyGroups: boolean;
  redisUrl: string;
  keyPrefix: string;
};

type Summary = {
  outputKeysScanned: number;
  outputKeysDeleted: number;
  outputKeysExpirySet: number;
  outputKeysMutated: number;
  outputKeysSkippedChanged: number;
  legacyGroupsFound: number;
  legacyGroupsDestroyed: number;
  pendingEntriesScanned: number;
  ignoredEntriesAcked: number;
  unresolvedPendingEntries: number;
  staleConsumersFound: number;
  sharedStreamsScanned: number;
  streamEntriesTrimmed: number;
};

type PendingEntry = {
  id: string;
};

function parseOptions(argv: readonly string[]): MigrationOptions {
  const apply = argv.includes("--apply");
  const rewriteAof = argv.includes("--rewrite-aof");
  const destroyLegacyGroups = argv.includes("--destroy-legacy-groups");
  const redisUrlArg = argv.find((arg) => arg.startsWith("--redis-url="));
  const keyPrefixArg = argv.find((arg) => arg.startsWith("--key-prefix="));
  const redisUrl = redisUrlArg?.slice("--redis-url=".length) ?? process.env.REDIS_URL;
  const keyPrefix = keyPrefixArg?.slice("--key-prefix=".length) ?? "lilac:event-bus";

  if (!redisUrl) {
    throw new Error("REDIS_URL or --redis-url=<url> is required");
  }
  if (apply && !argv.includes(REQUIRED_DEPLOY_CONFIRMATION)) {
    throw new Error(`--apply requires ${REQUIRED_DEPLOY_CONFIRMATION}`);
  }
  if (rewriteAof && !apply) {
    throw new Error("--rewrite-aof requires --apply");
  }
  if (destroyLegacyGroups && !apply) {
    throw new Error("--destroy-legacy-groups requires --apply");
  }
  if (destroyLegacyGroups && !argv.includes(REQUIRED_LEGACY_PROCESS_CONFIRMATION)) {
    throw new Error(`--destroy-legacy-groups requires ${REQUIRED_LEGACY_PROCESS_CONFIRMATION}`);
  }

  return { apply, rewriteAof, destroyLegacyGroups, redisUrl, keyPrefix };
}

function pairsToRecord(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};

  const record: Record<string, unknown> = {};
  for (let index = 0; index + 1 < value.length; index += 2) {
    const key = value[index];
    if (typeof key === "string") record[key] = value[index + 1];
  }
  return record;
}

function streamTopic(keyPrefix: string, streamKey: string): string | null {
  const prefix = `${keyPrefix}:`;
  return streamKey.startsWith(prefix) ? streamKey.slice(prefix.length) : null;
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT);
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== "0");
  return keys;
}

function parseStreamTimestamp(id: string): number | null {
  const separator = id.indexOf("-");
  if (separator <= 0) return null;
  const timestamp = Number(id.slice(0, separator));
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function parseEventFields(rawFields: unknown): { type: string; data: unknown } | null {
  const fields = pairsToRecord(rawFields);
  const type = fields["type"];
  const rawData = fields["data"];
  if (typeof type !== "string" || typeof rawData !== "string") return null;

  try {
    return { type, data: SuperJSON.parse(rawData) };
  } catch {
    return null;
  }
}

function adapterPlatform(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("platform" in data)) return null;
  return typeof data.platform === "string" ? data.platform : null;
}

function isSafelyIgnoredPending(params: {
  streamKey: string;
  group: string;
  event: { type: string; data: unknown };
  keyPrefix: string;
}): boolean {
  if (
    params.streamKey === `${params.keyPrefix}:evt.adapter` &&
    params.group === "core:router:adapter"
  ) {
    if (params.event.type !== "evt.adapter.message.created") return true;
    const platform = adapterPlatform(params.event.data);
    return platform !== null && platform !== "discord";
  }

  if (
    params.streamKey === `${params.keyPrefix}:evt.request` &&
    (params.group === "core:heartbeat:lifecycle" || params.group === "core:router:lifecycle")
  ) {
    return params.event.type === "evt.request.reply";
  }

  return false;
}

async function readPendingPage(
  redis: Redis,
  streamKey: string,
  group: string,
  start: string,
): Promise<PendingEntry[]> {
  const raw = (await redis.xpending(streamKey, group, start, "+", PENDING_BATCH_SIZE)) as unknown;
  if (!Array.isArray(raw)) return [];

  const entries: PendingEntry[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || typeof item[0] !== "string") continue;
    entries.push({ id: item[0] });
  }
  return entries;
}

async function readEventsAtIds(
  redis: Redis,
  streamKey: string,
  ids: readonly string[],
): Promise<Map<string, { type: string; data: unknown }>> {
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.xrange(streamKey, id, id, "COUNT", 1);
  const rawResults = (await pipeline.exec()) as unknown;
  const events = new Map<string, { type: string; data: unknown }>();
  if (!Array.isArray(rawResults)) return events;

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const result = rawResults[index];
    if (!id || !Array.isArray(result) || result[0] !== null) continue;
    const entries = result[1];
    if (!Array.isArray(entries) || !Array.isArray(entries[0])) continue;
    const event = parseEventFields(entries[0][1]);
    if (event) events.set(id, event);
  }
  return events;
}

async function migrateOutputExpirations(
  redis: Redis,
  options: MigrationOptions,
  summary: Summary,
): Promise<void> {
  const outputKeys = await scanKeys(redis, `${options.keyPrefix}:out.req.*`);
  const now = Date.now();

  for (const streamKey of outputKeys) {
    summary.outputKeysScanned += 1;
    const rawEntries = (await redis.xrevrange(streamKey, "+", "-", "COUNT", 1)) as unknown;
    const newestEntry = Array.isArray(rawEntries) ? rawEntries[0] : undefined;
    const lastGeneratedId =
      Array.isArray(newestEntry) && typeof newestEntry[0] === "string" ? newestEntry[0] : "0-0";
    const lastActivity = parseStreamTimestamp(lastGeneratedId);
    const expiresAt = lastActivity === null ? 0 : lastActivity + OUTPUT_TTL_MS;

    if (expiresAt <= now) {
      summary.outputKeysDeleted += 1;
    } else {
      summary.outputKeysExpirySet += 1;
    }

    if (options.apply) {
      const changed = await redis.eval(
        SET_OUTPUT_EXPIRY_IF_UNCHANGED_SCRIPT,
        1,
        streamKey,
        lastGeneratedId,
        String(expiresAt),
      );
      if (changed === 1) summary.outputKeysMutated += 1;
      else summary.outputKeysSkippedChanged += 1;
    }
  }
}

async function removeLegacyEphemeralGroups(
  redis: Redis,
  options: MigrationOptions,
  summary: Summary,
): Promise<void> {
  const streamKey = `${options.keyPrefix}:evt.request`;
  if ((await redis.exists(streamKey)) === 0) return;
  const rawGroups = (await redis.xinfo("GROUPS", streamKey)) as unknown;
  if (!Array.isArray(rawGroups)) return;

  for (const rawGroup of rawGroups) {
    const name = pairsToRecord(rawGroup)["name"];
    if (
      typeof name !== "string" ||
      !LEGACY_EPHEMERAL_GROUP_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      continue;
    }

    summary.legacyGroupsFound += 1;
    if (options.destroyLegacyGroups) {
      const destroyed = await redis.xgroup("DESTROY", streamKey, name);
      if (typeof destroyed === "number") summary.legacyGroupsDestroyed += destroyed;
    }
  }
}

async function repairKnownIgnoredPending(
  redis: Redis,
  options: MigrationOptions,
  summary: Summary,
): Promise<void> {
  const targets = [
    { streamKey: `${options.keyPrefix}:evt.adapter`, group: "core:router:adapter" },
    { streamKey: `${options.keyPrefix}:evt.request`, group: "core:heartbeat:lifecycle" },
    { streamKey: `${options.keyPrefix}:evt.request`, group: "core:router:lifecycle" },
  ] as const;

  for (const target of targets) {
    if ((await redis.exists(target.streamKey)) === 0) continue;
    const rawGroups = (await redis.xinfo("GROUPS", target.streamKey)) as unknown;
    const hasTargetGroup =
      Array.isArray(rawGroups) &&
      rawGroups.some((rawGroup) => pairsToRecord(rawGroup)["name"] === target.group);
    if (!hasTargetGroup) continue;

    let start = "-";
    while (true) {
      const page = await readPendingPage(redis, target.streamKey, target.group, start);
      if (page.length === 0) break;

      const safeIds: string[] = [];
      const events = await readEventsAtIds(
        redis,
        target.streamKey,
        page.map((pending) => pending.id),
      );
      for (const pending of page) {
        summary.pendingEntriesScanned += 1;
        const event = events.get(pending.id);
        if (
          event &&
          isSafelyIgnoredPending({
            streamKey: target.streamKey,
            group: target.group,
            event,
            keyPrefix: options.keyPrefix,
          })
        ) {
          safeIds.push(pending.id);
        } else {
          summary.unresolvedPendingEntries += 1;
        }
      }

      summary.ignoredEntriesAcked += safeIds.length;
      if (options.apply && safeIds.length > 0) {
        await redis.xack(target.streamKey, target.group, ...safeIds);
      }

      const lastId = page.at(-1)?.id;
      if (!lastId || page.length < PENDING_BATCH_SIZE) break;
      start = `(${lastId}`;
    }
  }
}

async function reportStaleEmptyConsumers(
  redis: Redis,
  sharedStreamKeys: readonly string[],
  summary: Summary,
): Promise<void> {
  for (const streamKey of sharedStreamKeys) {
    const rawGroups = (await redis.xinfo("GROUPS", streamKey)) as unknown;
    if (!Array.isArray(rawGroups)) continue;

    for (const rawGroup of rawGroups) {
      const groupName = pairsToRecord(rawGroup)["name"];
      if (typeof groupName !== "string") continue;
      const rawConsumers = (await redis.xinfo("CONSUMERS", streamKey, groupName)) as unknown;
      if (!Array.isArray(rawConsumers)) continue;

      for (const rawConsumer of rawConsumers) {
        const consumer = pairsToRecord(rawConsumer);
        const name = consumer["name"];
        const pending = consumer["pending"];
        const idle = consumer["idle"];
        if (
          typeof name !== "string" ||
          pending !== 0 ||
          typeof idle !== "number" ||
          idle < STALE_CONSUMER_IDLE_MS
        ) {
          continue;
        }

        summary.staleConsumersFound += 1;
      }
    }
  }
}

async function trimSharedStreams(
  redis: Redis,
  options: MigrationOptions,
  sharedStreamKeys: readonly string[],
  summary: Summary,
): Promise<void> {
  for (const streamKey of sharedStreamKeys) {
    const topic = streamTopic(options.keyPrefix, streamKey);
    if (!topic || TAIL_REPLAY_TOPICS.has(topic)) continue;
    summary.sharedStreamsScanned += 1;
    if (!options.apply) continue;

    const trimmed = await redis.eval(TRIM_ACKNOWLEDGED_PREFIX_SCRIPT, 1, streamKey);
    if (typeof trimmed === "number") summary.streamEntriesTrimmed += trimmed;
  }
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  const redis = new Redis(options.redisUrl, { lazyConnect: true });
  const summary: Summary = {
    outputKeysScanned: 0,
    outputKeysDeleted: 0,
    outputKeysExpirySet: 0,
    outputKeysMutated: 0,
    outputKeysSkippedChanged: 0,
    legacyGroupsFound: 0,
    legacyGroupsDestroyed: 0,
    pendingEntriesScanned: 0,
    ignoredEntriesAcked: 0,
    unresolvedPendingEntries: 0,
    staleConsumersFound: 0,
    sharedStreamsScanned: 0,
    streamEntriesTrimmed: 0,
  };

  try {
    await redis.connect();
    const allKeys = await scanKeys(redis, `${options.keyPrefix}:*`);
    const sharedStreamKeys: string[] = [];
    for (const key of allKeys) {
      if (
        !key.startsWith(`${options.keyPrefix}:out.req.`) &&
        (await redis.type(key)) === "stream"
      ) {
        sharedStreamKeys.push(key);
      }
    }

    await migrateOutputExpirations(redis, options, summary);
    await removeLegacyEphemeralGroups(redis, options, summary);
    await repairKnownIgnoredPending(redis, options, summary);
    await reportStaleEmptyConsumers(redis, sharedStreamKeys, summary);
    await trimSharedStreams(redis, options, sharedStreamKeys, summary);

    if (options.rewriteAof) await redis.bgrewriteaof();

    console.log(
      JSON.stringify(
        {
          mode: options.apply ? "apply" : "dry-run",
          keyPrefix: options.keyPrefix,
          rewriteAofRequested: options.rewriteAof,
          destroyLegacyGroupsRequested: options.destroyLegacyGroups,
          summary,
          note: options.apply
            ? "Cleanup applied. Re-run in dry-run mode and inspect INFO memory/persistence."
            : `No writes performed. Re-run with --apply ${REQUIRED_DEPLOY_CONFIRMATION} after deploying fc24e98.`,
        },
        null,
        2,
      ),
    );
  } finally {
    redis.disconnect();
  }
}

await main();
