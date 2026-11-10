import { displayPartSchema } from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import type {
  DisplayMessage,
  Hydration,
  LiveUpdate,
  ReadyTurnSlot,
  ReplayCheckpoint,
  ReplayReply,
  TurnSlot,
  TurnPage,
} from "@stanley2058/lilac-client-protocol";
import type { CachePatch, CachedSlot, ThreadCheckpoint } from "./cache.ts";

export type StoreChange = { slotIds: readonly string[]; structure: boolean; patch?: CachePatch };
export type ApplyOutcome = "applied" | "ignored" | "resync";
type Listener = (change: StoreChange) => void;

export function decodeDisplayPartFragment(json: string) {
  const value: unknown = Result.try({
    try: () => JSON.parse(json),
    catch: () => "invalid fragment",
  }).match({ ok: (parsed) => parsed, err: () => undefined });
  const decoded = displayPartSchema.safeParse(value);
  return decoded.success ? decoded.data : undefined;
}

function messagePosition(
  headers: DisplayMessage[],
  id: string,
  messages: DisplayMessage[],
): number {
  return (
    (headers.find((message) => message.id === id) ?? messages.find((message) => message.id === id))
      ?.metadata?.position ?? 0
  );
}
function end(slot: TurnSlot): number {
  return slot.kind === "ready" ? slot.position + 1 : slot.endPosition;
}
function older(a: ReplayCheckpoint, b: ReplayCheckpoint): boolean {
  return (
    a.historyGeneration < b.historyGeneration ||
    (a.historyGeneration === b.historyGeneration && a.projectionRevision < b.projectionRevision)
  );
}
function validSlots(slots: readonly TurnSlot[]): boolean {
  const ids = new Set<string>();
  const turns = new Set<string>();
  let previousEnd = -1;
  for (const slot of slots) {
    if (ids.has(slot.slotId) || slot.position < previousEnd) return false;
    if (slot.kind === "ready" && turns.has(slot.turnId)) return false;
    ids.add(slot.slotId);
    if (slot.kind === "ready") turns.add(slot.turnId);
    previousEnd = end(slot);
  }
  return true;
}

export class NativeThreadStore {
  private readonly slots = new Map<string, CachedSlot>();
  private readonly fragments = new Map<string, string>();
  private readonly turns = new Map<string, string>();
  private ordered: string[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly slotListeners = new Map<string, Set<() => void>>();
  private current: ReplayCheckpoint | undefined;
  private floor: ReplayCheckpoint | undefined;
  private structureRevision = 0;
  constructor(private readonly onObserverRelease?: () => void) {}

  get observerCount(): number {
    let count = this.listeners.size;
    for (const listeners of this.slotListeners.values()) count += listeners.size;
    return count;
  }

  get checkpoint(): ReplayCheckpoint | undefined {
    return this.current;
  }
  get resyncRequired(): boolean {
    return this.floor !== undefined;
  }
  get version(): number {
    return this.structureRevision;
  }
  get size(): number {
    return this.ordered.length;
  }
  get slotIds(): readonly string[] {
    return this.ordered;
  }
  get(slotId: string): TurnSlot | undefined {
    return this.slots.get(slotId)?.slot;
  }
  getVersioned(slotId: string): CachedSlot | undefined {
    return this.slots.get(slotId);
  }
  at(index: number): TurnSlot | undefined {
    const id = this.ordered[index];
    return id === undefined ? undefined : this.get(id);
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      if (this.listeners.delete(listener)) this.onObserverRelease?.();
    };
  }
  subscribeSlot(slotId: string, listener: () => void): () => void {
    const listeners = this.slotListeners.get(slotId) ?? new Set<() => void>();
    listeners.add(listener);
    this.slotListeners.set(slotId, listeners);
    return () => {
      const removed = listeners.delete(listener);
      if (!listeners.size) this.slotListeners.delete(slotId);
      if (removed) this.onObserverRelease?.();
    };
  }
  private publish(change: StoreChange): void {
    if (change.structure) this.structureRevision++;
    for (const id of change.slotIds) {
      for (const listener of this.slotListeners.get(id) ?? []) listener();
    }
    for (const listener of this.listeners) listener(change);
  }
  private requireResync(checkpoint: ReplayCheckpoint): ApplyOutcome {
    if (!this.floor || older(this.floor, checkpoint)) this.floor = checkpoint;
    this.publish({ slotIds: [], structure: false });
    return "resync";
  }
  clear(): void {
    const ids = this.ordered;
    this.fragments.clear();
    this.slots.clear();
    this.turns.clear();
    this.ordered = [];
    this.current = undefined;
    this.floor = undefined;
    this.publish({ slotIds: ids, structure: true });
  }
  restore(value: ThreadCheckpoint): ApplyOutcome {
    if (this.current) return "ignored";
    if (!validSlots(value.slots.map(({ slot }) => slot))) return "ignored";
    if (value.slots.some(({ revision }) => revision > value.checkpoint.projectionRevision))
      return "ignored";
    this.current = value.checkpoint;
    for (const slot of value.slots) {
      this.slots.set(slot.slot.slotId, slot);
      if (slot.slot.kind === "ready") this.turns.set(slot.slot.turnId, slot.slot.slotId);
    }
    this.ordered = value.slots.map(({ slot }) => slot.slotId);
    this.publish({ slotIds: this.ordered, structure: true });
    return "applied";
  }
  replay(reply: ReplayReply): ApplyOutcome {
    if (reply.kind === "delta")
      return this.update(
        { checkpoint: reply.checkpoint, changes: reply.changes },
        reply.fromRevision,
      );
    if (reply.kind === "unchanged") {
      if (!this.current || this.floor) return "ignored";
      if (older(reply.checkpoint, this.current) || older(this.current, reply.checkpoint))
        return "ignored";
      this.current = reply.checkpoint;
      this.publish({
        slotIds: [],
        structure: false,
        patch: { checkpoint: reply.checkpoint, replace: false, put: [], remove: [] },
      });
      return "applied";
    }
    if (this.floor && older(reply.checkpoint, this.floor)) return "ignored";
    if (this.current && older(reply.checkpoint, this.current)) return "ignored";
    if (this.current && !this.floor && !older(this.current, reply.checkpoint)) return "ignored";
    if (!validSlots(reply.slots)) return this.requireResync(reply.checkpoint);
    const oldIds = this.ordered;
    this.fragments.clear();
    this.slots.clear();
    this.turns.clear();
    const put = reply.slots.map((slot) => ({
      revision: reply.checkpoint.projectionRevision,
      slot,
    }));
    for (const slot of put) {
      this.slots.set(slot.slot.slotId, slot);
      if (slot.slot.kind === "ready") this.turns.set(slot.slot.turnId, slot.slot.slotId);
    }
    this.ordered = reply.slots.map((slot) => slot.slotId);
    this.current = reply.checkpoint;
    this.floor = undefined;
    this.publish({
      slotIds: [...new Set([...oldIds, ...this.ordered])],
      structure: true,
      patch: { checkpoint: reply.checkpoint, replace: true, put, remove: [] },
    });
    return "applied";
  }
  private indexAt(position: number): number {
    let low = 0;
    let high = this.ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const slot = this.at(middle);
      if (slot && slot.position <= position) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }
  hydrate(hydration: Hydration): ApplyOutcome {
    if (
      !this.current ||
      this.floor ||
      this.current.historyGeneration !== hydration.historyGeneration
    )
      return "ignored";
    const target = this.slots.get(hydration.slotId);
    if (
      !target ||
      target.slot.kind === "ready" ||
      target.revision > hydration.projectionRevision ||
      hydration.projectionRevision > this.current.projectionRevision
    )
      return "ignored";
    if (!validSlots(hydration.slots)) return "ignored";
    const first = hydration.slots[0];
    const last = hydration.slots.at(-1);
    if (
      !first ||
      !last ||
      first.position !== target.slot.position ||
      end(last) !== end(target.slot)
    )
      return "ignored";
    for (let index = 0; index < hydration.slots.length; index++) {
      const slot = hydration.slots[index];
      if (!slot) return "ignored";
      const previous = hydration.slots[index - 1];
      if (previous && end(previous) !== slot.position) return "ignored";
      if (slot.slotId !== hydration.slotId && this.slots.has(slot.slotId)) return "ignored";
      if (slot.kind === "ready" && this.turns.has(slot.turnId)) return "ignored";
    }
    const index = this.indexAt(target.slot.position);
    const put = hydration.slots.map((slot) => ({ revision: hydration.projectionRevision, slot }));
    this.slots.delete(hydration.slotId);
    for (const slot of put) {
      this.slots.set(slot.slot.slotId, slot);
      if (slot.slot.kind === "ready") this.turns.set(slot.slot.turnId, slot.slot.slotId);
    }
    this.ordered = this.ordered.toSpliced(index, 1, ...hydration.slots.map((slot) => slot.slotId));
    this.publish({
      slotIds: [hydration.slotId, ...hydration.slots.map((slot) => slot.slotId)],
      structure: true,
      patch: { checkpoint: this.current, replace: false, put, remove: [hydration.slotId] },
    });
    return "applied";
  }
  failHydration(slotId: string, message: string): void {
    const target = this.slots.get(slotId);
    if (!target || target.slot.kind === "ready" || !this.current) return;
    const value: CachedSlot = {
      revision: target.revision,
      slot: {
        ...target.slot,
        kind: "failed",
        retryable: true,
        message,
      },
    };
    this.slots.set(slotId, value);
    this.publish({
      slotIds: [slotId],
      structure: false,
      patch: {
        checkpoint: this.current,
        replace: false,
        put: [value],
        remove: [],
      },
    });
  }
  turnPage(slotId: string, expectedCursor: string, page: TurnPage): ApplyOutcome {
    if (!this.current || this.floor || page.historyGeneration !== this.current.historyGeneration)
      return "ignored";
    const target = this.slots.get(slotId);
    if (!target || target.slot.kind !== "ready" || target.slot.turnId !== page.turnId)
      return "ignored";
    if (
      target.revision > page.projectionRevision ||
      page.projectionRevision > this.current.projectionRevision ||
      target.slot.partsCursor !== expectedCursor
    )
      return "ignored";
    let messages = target.slot.messages;
    let resumeCursor: string | undefined;
    const indexes = new Map(messages.map((message, index) => [message.id, index]));
    for (const message of page.messages) {
      const existingIndex = indexes.get(message.id);
      if (existingIndex !== undefined) {
        const existing = messages[existingIndex];
        if (
          !existing ||
          existing.role !== message.role ||
          JSON.stringify(existing.metadata) !== JSON.stringify(message.metadata)
        )
          return "ignored";
        for (let index = 0; index < message.parts.length; index++) {
          if (JSON.stringify(existing.parts[index]) !== JSON.stringify(message.parts[index]))
            return "ignored";
        }
        continue;
      }
      indexes.set(message.id, messages.length);
      messages = [...messages, message];
    }
    for (const received of page.chunks ?? []) {
      let chunk = received;
      if (received.fragment) {
        const fragment = received.fragment;
        const key = JSON.stringify([
          page.historyGeneration,
          page.projectionRevision,
          page.turnId,
          received.messageId,
          received.partIndex,
        ]);
        const previous = fragment.offset === 0 ? "" : (this.fragments.get(key) ?? "");
        if (previous.length !== fragment.offset) return "ignored";
        const json = previous + fragment.json;
        if (json.length < fragment.total) {
          this.fragments.set(key, json);
          resumeCursor = `p_${messagePosition(page.messages, received.messageId, messages)}_${received.partIndex}_0`;
          continue;
        }
        const decoded = decodeDisplayPartFragment(json);
        if (!decoded) return "ignored";
        this.fragments.delete(key);
        resumeCursor = undefined;
        chunk = { ...received, part: decoded };
      }
      const index = indexes.get(chunk.messageId);
      if (index === undefined) return "ignored";
      const message = messages[index];
      if (!message || chunk.partIndex > message.parts.length) return "ignored";
      if (chunk.partIndex < message.parts.length) {
        if (JSON.stringify(message.parts[chunk.partIndex]) !== JSON.stringify(chunk.part))
          return "ignored";
        continue;
      }
      messages = messages.with(index, { ...message, parts: [...message.parts, chunk.part] });
    }
    messages = [...messages].sort(
      (a, b) => (a.metadata?.position ?? 0) - (b.metadata?.position ?? 0),
    );
    const value: CachedSlot = {
      revision: page.projectionRevision,
      slot: {
        ...target.slot,
        messages,
        partsCursor: page.nextCursor,
      },
    };
    this.slots.set(slotId, value);
    this.publish({
      slotIds: [slotId],
      structure: false,
      patch: {
        checkpoint: this.current,
        replace: false,
        put: [
          resumeCursor && value.slot.kind === "ready"
            ? { ...value, slot: { ...value.slot, partsCursor: resumeCursor } }
            : value,
        ],
        remove: [],
      },
    });
    return "applied";
  }
  update(
    update: LiveUpdate,
    fromRevision = update.checkpoint.projectionRevision - 1,
  ): ApplyOutcome {
    const checkpoint = update.checkpoint;
    if (!this.current) return this.requireResync(checkpoint);
    if (older(checkpoint, this.current)) return "ignored";
    if (this.floor) return this.requireResync(checkpoint);
    if (checkpoint.historyGeneration !== this.current.historyGeneration)
      return this.requireResync(checkpoint);
    if (checkpoint.projectionRevision <= this.current.projectionRevision) return "ignored";
    if (fromRevision !== this.current.projectionRevision) return this.requireResync(checkpoint);
    const draft = new Map<string, CachedSlot>();
    const removed = new Set<string>();
    const insertedPositions = new Map<number, TurnSlot>();
    let ordered = this.ordered;
    for (const change of update.changes) {
      if (change.kind === "insert") {
        if (this.slots.has(change.slot.slotId) || draft.has(change.slot.slotId))
          return this.requireResync(checkpoint);
        const index = this.indexAt(change.slot.position);
        const previous = this.at(index);
        if (previous && end(previous) > change.slot.position) return this.requireResync(checkpoint);
        if (this.turns.has(change.slot.turnId)) return this.requireResync(checkpoint);
        draft.set(change.slot.slotId, {
          revision: checkpoint.projectionRevision,
          slot: change.slot,
        });
        insertedPositions.set(change.slot.position, change.slot);
        ordered = [...ordered, change.slot.slotId];
        continue;
      }
      const original =
        insertedPositions.get(change.position) ?? this.at(this.indexAt(change.position));
      if (!original || change.position >= end(original) || removed.has(original.slotId))
        return this.requireResync(checkpoint);
      const target = draft.get(original.slotId) ?? this.slots.get(original.slotId);
      if (!target) return this.requireResync(checkpoint);
      if (change.kind === "remove") {
        if (target.slot.kind !== "ready" || target.slot.turnId !== change.turnId)
          return this.requireResync(checkpoint);
        removed.add(target.slot.slotId);
        draft.delete(target.slot.slotId);
        ordered = ordered.filter((id) => id !== target.slot.slotId);
        continue;
      }
      if (target.slot.kind !== "ready") {
        draft.set(target.slot.slotId, { ...target, revision: checkpoint.projectionRevision });
        continue;
      }
      if (target.slot.turnId !== change.turnId) return this.requireResync(checkpoint);
      const slot = applyReadyChange(target.slot, change);
      if (!slot) return this.requireResync(checkpoint);
      draft.set(slot.slotId, { revision: checkpoint.projectionRevision, slot });
    }
    if (ordered !== this.ordered) {
      ordered.sort(
        (a, b) =>
          (draft.get(a) ?? this.slots.get(a))!.slot.position -
          (draft.get(b) ?? this.slots.get(b))!.slot.position,
      );
      const values = ordered.map((id) => (draft.get(id) ?? this.slots.get(id))!.slot);
      if (!validSlots(values)) return this.requireResync(checkpoint);
    }
    const structure = ordered !== this.ordered;
    for (const id of removed) {
      const slot = this.slots.get(id)?.slot;
      if (slot?.kind === "ready") this.turns.delete(slot.turnId);
      this.slots.delete(id);
    }
    for (const [id, slot] of draft) {
      this.slots.set(id, slot);
      if (slot.slot.kind === "ready") this.turns.set(slot.slot.turnId, id);
    }
    this.ordered = ordered;
    this.current = checkpoint;
    this.publish({
      slotIds: [...draft.keys(), ...removed],
      structure,
      patch: {
        checkpoint,
        replace: false,
        put: [...draft.values()],
        remove: [...removed],
      },
    });
    return "applied";
  }
}

function applyReadyChange(
  slot: ReadyTurnSlot,
  change: LiveUpdate["changes"][number],
): ReadyTurnSlot | undefined {
  if (
    slot.partsCursor &&
    (change.kind === "append-message" ||
      change.kind === "remove-message" ||
      change.kind === "truncate-parts")
  )
    return undefined;
  if (change.kind === "turn-state")
    return {
      ...slot,
      state: change.state,
      runId: change.runId ?? slot.runId,
      startedAt: change.startedAt ?? slot.startedAt,
      settledAt: change.state === "running" ? undefined : (change.settledAt ?? slot.settledAt),
    };
  if (change.kind === "append-message") {
    if (slot.messages.some((message) => message.id === change.message.id)) return undefined;
    const index =
      change.beforeMessageId === undefined
        ? slot.messages.length
        : slot.messages.findIndex((message) => message.id === change.beforeMessageId);
    if (index < 0) return undefined;
    return { ...slot, messages: slot.messages.toSpliced(index, 0, change.message) };
  }
  if (change.kind === "remove-message") {
    const index = slot.messages.findIndex((message) => message.id === change.messageId);
    if (index < 0) return undefined;
    return { ...slot, messages: slot.messages.toSpliced(index, 1) };
  }
  if (
    change.kind !== "message-meta" &&
    change.kind !== "truncate-parts" &&
    change.kind !== "append-text" &&
    change.kind !== "set-part"
  )
    return undefined;
  const index = slot.messages.findIndex((message) => message.id === change.messageId);
  const message = slot.messages[index];
  if (!message) return undefined;
  const next = updateDisplayMessage(message, change);
  return next ? { ...slot, messages: slot.messages.with(index, next) } : undefined;
}

export function updateDisplayMessage(
  message: DisplayMessage,
  change: Extract<
    LiveUpdate["changes"][number],
    { kind: "message-meta" | "truncate-parts" | "append-text" | "set-part" }
  >,
): DisplayMessage | undefined {
  switch (change.kind) {
    case "message-meta":
      return { ...message, metadata: { ...message.metadata, ...change.metadata } };
    case "truncate-parts":
      if (change.length > message.parts.length) return undefined;
      return { ...message, parts: message.parts.slice(0, change.length) };
    case "set-part": {
      if (change.partIndex > message.parts.length) return undefined;
      const parts = [...message.parts];
      parts[change.partIndex] = change.part;
      return { ...message, parts };
    }
    case "append-text": {
      const part = message.parts[change.partIndex];
      if (!part || part.type !== "text") return undefined;
      return {
        ...message,
        parts: message.parts.with(change.partIndex, { ...part, text: part.text + change.text }),
      };
    }
  }
}
