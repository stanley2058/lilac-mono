import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { generateVAPIDKeys, sendNotification, WebPushError } from "web-push";
import { Result } from "better-result";
import type { NativeRpcInputs, NativeThread } from "@stanley2058/lilac-client-protocol";
import { nativeFailure } from "./errors";
import { nativeStoreTransaction, type NativeStore } from "./store";

type Subscription = {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  completion: number;
  failure: number;
};
export const PUSH_ESCALATION_MS = 60_000;
type Escalation = {
  userId: string;
  threadId: string;
  turnId: string;
  generation: number;
  endpoint: string;
  timer: ReturnType<typeof setTimeout>;
};
type Keys = { publicKey: string; privateKey: string };

export function allowedPushEndpoint(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash)
    return false;
  return (
    url.hostname === "fcm.googleapis.com" ||
    url.hostname === "updates.push.services.mozilla.com" ||
    url.hostname.endsWith(".push.apple.com") ||
    url.hostname.endsWith(".notify.windows.com")
  );
}

function needsInput(thread: NativeThread) {
  return thread.displayStatus === "input" || thread.waitingOn === "input";
}

export class NativePush {
  private readonly viewing = new Map<
    string,
    { userId: string; threadId: string; until: number; signal?: AbortSignal; onAbort?: () => void }
  >();
  private readonly working = new Map<string, NativeThread>();
  private readonly awaitingInput = new Set<string>();
  private readonly pending = new Set<Promise<boolean | void>>();
  private readonly escalations = new Map<string, Escalation>();
  private stopped = false;
  private stopListening?: () => void;
  constructor(
    private readonly db: Database,
    private readonly store: NativeStore,
    private readonly send = sendNotification,
  ) {}

  key() {
    return nativeStoreTransaction(this.db, () => {
      const keys = this.keys() ?? this.createKeys();
      return Result.ok({ publicKey: keys.publicKey });
    });
  }

  private createKeys(): Keys {
    const keys = generateVAPIDKeys();
    this.db
      .query("INSERT INTO native_push_keys(id,public_key,private_key) VALUES(1,?,?)")
      .run(keys.publicKey, keys.privateKey);
    return keys;
  }

  private keys(): Keys | null {
    return this.db
      .query<Keys, []>(
        "SELECT public_key AS publicKey,private_key AS privateKey FROM native_push_keys WHERE id=1",
      )
      .get();
  }

  subscribe(userId: string, input: NativeRpcInputs["notifications"]["subscribe"]) {
    if (!allowedPushEndpoint(input.endpoint))
      return Result.err(nativeFailure("invalid", "Unsupported push service"));
    return nativeStoreTransaction(this.db, () => {
      const count =
        this.db
          .query<{ count: number }, [string, string]>(
            "SELECT count(*) AS count FROM native_push_subscriptions WHERE user_id=? AND endpoint<>?",
          )
          .get(userId, input.endpoint)?.count ?? 0;
      if (count >= 16) return Result.err(nativeFailure("invalid", "Too many notification devices"));
      this.db
        .query(
          "INSERT INTO native_push_subscriptions(endpoint,user_id,p256dh,auth,completion,failure) VALUES(?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,completion=excluded.completion,failure=excluded.failure",
        )
        .run(
          input.endpoint,
          userId,
          input.keys.p256dh,
          input.keys.auth,
          Number(input.completion),
          Number(input.failure),
        );
      this.trackWorking(userId);
      return Result.ok({ ok: true as const });
    });
  }

  private trackWorking(userId: string) {
    const records = this.db
      .query<{ id: string }, []>("SELECT id FROM native_records WHERE kind='thread'")
      .all();
    for (const record of records) {
      const thread = this.store
        .getThread(userId, record.id)
        .match({ ok: (value) => value, err: () => undefined });
      if (!thread || thread.archived || !thread.capabilities.read) continue;
      if (thread.displayStatus === "working") this.working.set(`${userId}:${thread.id}`, thread);
      if (needsInput(thread)) this.awaitingInput.add(`${userId}:${thread.id}`);
    }
  }

  unsubscribe(userId: string, endpoint: string) {
    this.db
      .query("DELETE FROM native_push_subscriptions WHERE endpoint=? AND user_id=?")
      .run(endpoint, userId);
    return Result.ok({ ok: true as const });
  }

  private clearPresence(key: string) {
    const view = this.viewing.get(key);
    if (view?.onAbort) view.signal?.removeEventListener("abort", view.onAbort);
    this.viewing.delete(key);
  }

  presence(
    userId: string,
    input: NativeRpcInputs["notifications"]["presence"],
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) return Result.ok({ ok: true as const });
    for (const [key, view] of this.viewing) if (view.until <= Date.now()) this.clearPresence(key);
    const key = JSON.stringify([userId, input.clientId]);
    this.clearPresence(key);
    if (!input.threadId) return Result.ok({ ok: true as const });
    const onAbort = () => this.clearPresence(key);
    this.viewing.set(key, {
      userId,
      threadId: input.threadId,
      until: Date.now() + 60_000,
      signal,
      onAbort,
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    return Result.ok({ ok: true as const });
  }

  start() {
    this.stopped = false;
    this.stopListening = this.store.subscribe((threadId) => this.changed(threadId));
  }

  posted(threadId: string) {
    const subscriptions = this.db
      .query<Subscription, []>("SELECT * FROM native_push_subscriptions")
      .all();
    for (const userId of new Set(subscriptions.map((entry) => entry.user_id))) {
      const thread = this.store
        .getThread(userId, threadId)
        .match({ ok: (value) => value, err: () => undefined });
      if (!thread || thread.archived || !thread.capabilities.read) continue;
      this.notify(userId, threadId, "completion", subscriptions);
    }
  }

  private changed(threadId: string) {
    if (!threadId) return;
    for (const [key, escalation] of this.escalations) {
      if (escalation.threadId === threadId && !this.unreadCompletion(escalation))
        this.cancelEscalation(key);
    }
    const subscriptions = this.db
      .query<Subscription, []>("SELECT * FROM native_push_subscriptions")
      .all();
    for (const userId of new Set(subscriptions.map((entry) => entry.user_id))) {
      const key = `${userId}:${threadId}`;
      const thread = this.store
        .getThread(userId, threadId)
        .match({ ok: (value) => value, err: () => undefined });
      if (!thread || thread.archived || !thread.capabilities.read) {
        this.working.delete(key);
        this.awaitingInput.delete(key);
        continue;
      }
      if (!needsInput(thread)) this.awaitingInput.delete(key);
      else if (!this.awaitingInput.has(key)) {
        this.awaitingInput.add(key);
        this.notify(userId, threadId, "completion", subscriptions);
      }
      if (thread.displayStatus === "input") {
        this.working.delete(key);
        continue;
      }
      if (thread.displayStatus === "working") {
        this.working.set(key, thread);
        continue;
      }
      if (thread.displayStatus === "idle") continue;
      const previous = this.working.get(key);
      this.working.delete(key);
      if (!previous || thread.revision <= previous.revision) continue;
      this.notify(
        userId,
        threadId,
        thread.displayStatus === "error" ? "failure" : "completion",
        subscriptions,
        true,
      );
    }
  }

  private notify(
    userId: string,
    threadId: string,
    kind: "completion" | "failure",
    subscriptions: Subscription[],
    stageCompletion = false,
  ) {
    if (
      [...this.viewing.values()].some(
        (viewing) =>
          viewing.userId === userId && viewing.threadId === threadId && viewing.until > Date.now(),
      )
    )
      return;
    const payload = this.store
      .notificationContent(userId, threadId)
      .match({ ok: (value) => value, err: () => undefined });
    const keys = this.keys();
    if (!payload || !keys) return;
    const eligible = subscriptions.filter((entry) => entry.user_id === userId && entry[kind]);
    if (
      stageCompletion &&
      kind === "completion" &&
      this.stageCompletion(userId, threadId, eligible, JSON.stringify(payload), keys)
    )
      return;
    for (const subscription of eligible)
      this.track(this.deliver(subscription, JSON.stringify(payload), keys));
  }

  private stageCompletion(
    userId: string,
    threadId: string,
    eligible: Subscription[],
    payload: string,
    keys: Keys,
  ): boolean {
    const origin = this.store
      .notificationOrigin(userId, threadId)
      .match({ ok: (value) => value, err: () => undefined });
    if (!origin || origin.userId !== userId || !origin.deviceId) return false;
    const primary = eligible.find(
      (entry) => createHash("sha256").update(entry.endpoint).digest("hex") === origin.deviceId,
    );
    if (!primary) return false;
    this.stage(
      { userId, threadId, turnId: origin.turnId, generation: origin.generation },
      primary,
      payload,
      keys,
    );
    return true;
  }

  private track(delivery: Promise<boolean | void>) {
    this.pending.add(delivery);
    void delivery.finally(() => this.pending.delete(delivery));
  }

  private cancelEscalation(key: string) {
    const escalation = this.escalations.get(key);
    if (!escalation) return;
    clearTimeout(escalation.timer);
    this.escalations.delete(key);
  }

  private unreadCompletion(escalation: Omit<Escalation, "timer" | "endpoint">) {
    const thread = this.store
      .getThread(escalation.userId, escalation.threadId)
      .match({ ok: (value) => value, err: () => undefined });
    if (
      !thread ||
      thread.archived ||
      !thread.capabilities.read ||
      thread.displayStatus !== "completed"
    )
      return false;
    const origin = this.store
      .notificationOrigin(escalation.userId, escalation.threadId)
      .match({ ok: (value) => value, err: () => undefined });
    return origin?.turnId === escalation.turnId && origin.generation === escalation.generation;
  }

  private stage(
    completion: Omit<Escalation, "timer" | "endpoint">,
    primary: Subscription,
    payload: string,
    keys: Keys,
  ) {
    const key = JSON.stringify([completion.userId, completion.threadId]);
    this.cancelEscalation(key);
    const escalation: Escalation = {
      ...completion,
      endpoint: primary.endpoint,
      timer: setTimeout(() => this.escalate(key, escalation), PUSH_ESCALATION_MS),
    };
    this.escalations.set(key, escalation);
    this.track(
      this.deliver(primary, payload, keys).then((delivered) => {
        if (!delivered) this.escalate(key, escalation);
      }),
    );
  }

  private escalate(key: string, escalation: Escalation) {
    if (this.stopped || this.escalations.get(key) !== escalation) return;
    this.cancelEscalation(key);
    if (!this.unreadCompletion(escalation)) return;
    const subscriptions = this.db
      .query<Subscription, []>("SELECT * FROM native_push_subscriptions")
      .all();
    this.notify(
      escalation.userId,
      escalation.threadId,
      "completion",
      subscriptions.filter((entry) => entry.endpoint !== escalation.endpoint),
    );
  }

  private async deliver(subscription: Subscription, payload: string, keys: Keys) {
    const result = await Result.tryPromise({
      try: () =>
        this.send(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
          {
            vapidDetails: { subject: "mailto:notifications@lilac.app", ...keys },
            TTL: 3600,
            timeout: 10_000,
          },
        ),
      catch: (error) => (error instanceof WebPushError ? error.statusCode : 0),
    });
    const status = result.match({ ok: () => 201, err: (value) => value });
    if (status === 404 || status === 410)
      this.unsubscribe(subscription.user_id, subscription.endpoint);
    return status >= 200 && status < 300;
  }

  async stop() {
    this.stopped = true;
    for (const key of this.escalations.keys()) this.cancelEscalation(key);
    this.stopListening?.();
    this.stopListening = undefined;
    await Promise.all(this.pending);
    this.working.clear();
    this.awaitingInput.clear();
    for (const key of this.viewing.keys()) this.clearPresence(key);
  }
}
