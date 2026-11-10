import { Panic, Result } from "better-result";
import type { ClientEvent, Completion } from "@stanley2058/lilac-client";
import type {
  DisplayCatalog,
  NativeInput,
  NativeThread,
  QueuedInput,
  TurnSlot,
} from "@stanley2058/lilac-client-protocol";
import type { TuiSession } from "./session.ts";
import { safeText } from "./plaintext.ts";
import { rethrowTuiDefect, captureTuiException } from "./fatal.ts";

export type Attachment = {
  id: string;
  file: Blob;
  name: string;
  resourceId?: string;
  progress: number;
  state: "pending" | "uploading" | "ready" | "failed";
  error?: string;
  sent: boolean;
};
export type TuiState = {
  connection: string;
  error?: string;
  notice?: string;
  threads: NativeThread[];
  nextCursor?: string;
  selected?: string;
  catalog?: DisplayCatalog;
  draft: string;
  modelId?: string;
  mode: "steer" | "followup";
  attachments: Attachment[];
  queue: QueuedInput[];
  slotIds: readonly string[];
  slotId?: string;
  version: number;
  historyVersion: number;
  submitting: boolean;
  uncertainId?: string;
};

export class TuiController {
  state: TuiState = {
    connection: "connecting",
    threads: [],
    draft: "",
    mode: "steer",
    attachments: [],
    queue: [],
    slotIds: [],
    version: 0,
    historyVersion: 0,
    submitting: false,
  };
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  private unsubscribeThread?: () => void;
  private selectedThread?: NativeThread;
  private readonly lifetime = new AbortController();
  private readonly uploads = new Map<string, AbortController>();
  constructor(
    readonly session: TuiSession,
    private readonly onDefect: (error: Error) => void = rethrowTuiDefect,
  ) {
    this.unsubscribe = session.client.subscribe((event) => this.event(event));
  }
  run(task: Promise<unknown>): void {
    void this.settleTask(task);
  }
  private async settleTask(task: Promise<unknown>): Promise<void> {
    const captured = await Result.tryPromise({
      try: () => task,
      catch: captureTuiException,
    });
    const failure = captured.match({ ok: () => undefined, err: (error) => error });
    if (failure) this.onDefect(failure);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  update(change: Partial<TuiState>): void {
    if (this.lifetime.signal.aborted) return;
    this.state = {
      ...this.state,
      ...change,
      version: this.state.version + 1,
      historyVersion:
        this.state.historyVersion +
        Number("slotIds" in change || "slotId" in change || "selected" in change),
    };
    for (const listener of this.listeners) listener();
  }
  async attempt<T>(operation: () => Promise<T>): Promise<T | undefined> {
    const captured = await Result.tryPromise({
      try: operation,
      catch: captureTuiException,
    });
    const outcome = captured.match<{ value: T } | { error: Error }>({
      ok: (value) => ({ value }),
      err: (error) => ({ error }),
    });
    if ("value" in outcome) return outcome.value;
    if (Panic.is(outcome.error)) rethrowTuiDefect(outcome.error);
    this.update({ error: safeText(outcome.error.message) });
    return undefined;
  }
  private event(event: ClientEvent): void {
    switch (event.kind) {
      case "connection":
        if (event.state === "logged-out") {
          this.clearPrivateState();
          return;
        }
        this.update({ connection: event.state });
        return;
      case "error":
        this.update({ error: event.error.message });
        return;
      case "catalog":
        this.update({ catalog: this.session.client.catalogs.get(this.session.scope) });
        return;
      case "bootstrap":
        this.selectedThread =
          event.bootstrap.threads.items.find((thread) => thread.id === this.state.selected) ??
          this.selectedThread;
        this.update({
          threads: event.bootstrap.threads.items,
          nextCursor: event.bootstrap.threads.nextCursor,
          catalog: this.session.client.catalogs.get(this.session.scope),
        });
        return;
      case "thread":
        if (event.thread.id === this.state.selected) this.selectedThread = event.thread;
        this.update({
          threads: [
            event.thread,
            ...this.state.threads.filter((thread) => thread.id !== event.thread.id),
          ]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 100),
        });
        return;
      case "removed":
        this.update({
          threads: this.state.threads.filter((thread) => thread.id !== event.threadId),
        });
        if (this.state.selected === event.threadId) {
          this.update({ submitting: false });
          this.clearPrivateState();
        }
        return;
      case "input":
        if (this.state.selected === event.threadId) this.run(this.refreshQueue());
        return;
      case "checkpoint":
        return;
    }
  }
  async start(threadId?: string): Promise<void> {
    if (threadId) this.bind(threadId);
    await this.session.client.start(threadId);
    if (!threadId) return;
    const rpc = this.session.client.rpc;
    if (!rpc) return;
    const thread = await this.attempt(() => rpc.threads.get({ threadId }));
    if (thread && this.state.selected === threadId) this.event({ kind: "thread", thread });
    await this.refreshQueue();
  }
  currentThread(): NativeThread | undefined {
    return this.selectedThread;
  }
  private clearPrivateState(): void {
    for (const transfer of this.uploads.values()) transfer.abort();
    this.uploads.clear();
    this.unsubscribeThread?.();
    this.unsubscribeThread = undefined;
    this.selectedThread = undefined;
    this.update({
      connection: "logged-out",
      threads: [],
      catalog: undefined,
      selected: undefined,
      slotIds: [],
      slotId: undefined,
      draft: "",
      attachments: [],
      queue: [],
      uncertainId: undefined,
      notice: "Temporary conversation ended. Restart lilac-tui for another.",
      error: undefined,
    });
  }
  currentSlot(): TurnSlot | undefined {
    if (!this.state.selected || !this.state.slotId) return undefined;
    return this.session.client.thread(this.state.selected).get(this.state.slotId);
  }
  private bind(threadId: string): void {
    this.unsubscribeThread?.();
    this.selectedThread = this.state.threads.find((thread) => thread.id === threadId);
    const store = this.session.client.thread(threadId);
    let generation = store.checkpoint?.historyGeneration;
    this.update({
      selected: threadId,
      slotIds: store.slotIds,
      slotId: store.slotIds.at(-1),
      draft: "",
      attachments: [],
      queue: [],
    });
    this.unsubscribeThread = store.subscribe(() => {
      const nextGeneration = store.checkpoint?.historyGeneration;
      const reset = generation !== undefined && nextGeneration !== generation;
      generation = nextGeneration;
      const previousTail = this.state.slotIds.at(-1);
      const atTail = !this.state.slotId || this.state.slotId === previousTail;
      const previousIndex = this.state.slotIds.indexOf(this.state.slotId ?? "");
      const replacement = store.slotIds[Math.max(0, previousIndex)];
      const retained = store.slotIds.includes(this.state.slotId!) ? this.state.slotId : replacement;
      const slotId = reset || atTail ? store.slotIds.at(-1) : retained;
      this.update({
        slotIds: store.slotIds,
        slotId,
        ...(reset ? { notice: "History reset. Showing the current conversation." } : {}),
      });
      this.hydrateVisible();
    });
    this.hydrateVisible();
  }
  private hydrateVisible(): void {
    const slot = this.currentSlot();
    if (this.state.selected && slot?.kind === "deferred")
      this.run(this.session.client.hydrate(this.state.selected, slot.slotId));
  }
  navigate(delta: number): void {
    const index = this.state.slotIds.indexOf(this.state.slotId ?? "");
    const slotId =
      this.state.slotIds[Math.max(0, Math.min(this.state.slotIds.length - 1, index + delta))];
    this.update({ slotId });
    this.hydrateVisible();
  }
  async more(): Promise<void> {
    if (!this.state.selected || !this.state.slotId) return;
    const slot = this.currentSlot();
    if (slot?.kind === "ready") {
      await this.session.client.loadTurnPage(this.state.selected, slot.slotId);
      return;
    }
    await this.session.client.hydrate(this.state.selected, this.state.slotId);
  }
  completions(): Completion[] {
    const match = /(?:^|\s)([$/])([^$/\n]*)$/.exec(this.state.draft);
    if (!match) return [];
    return this.session.client.catalogs.complete(
      this.session.scope,
      match[1] === "$" ? "$" : "/",
      match[2] ?? "",
      30,
    );
  }
  complete(completion: Completion): void {
    this.update({
      draft: this.state.draft.replace(/([$/])([^$/\n]*)$/, `${completion.insertText} `),
    });
  }
  attach(file: Blob, name: string): void {
    if (this.state.attachments.filter((item) => !item.sent).length >= 32) {
      this.update({ error: "A message can contain at most 32 files." });
      return;
    }
    this.update({
      attachments: [
        ...this.state.attachments,
        { id: crypto.randomUUID(), file, name, progress: 0, state: "pending", sent: false },
      ],
    });
  }
  removeAttachment(id: string): void {
    this.uploads.get(id)?.abort();
    this.uploads.delete(id);
    this.update({ attachments: this.state.attachments.filter((item) => item.id !== id) });
  }
  private patchAttachment(attachment: Attachment, patch: Partial<Attachment>): void {
    Object.assign(attachment, patch);
    this.update({ attachments: [...this.state.attachments] });
  }
  private releaseCompletedUploads(): void {
    const keep = (attachment: Attachment) => !(attachment.sent && attachment.state === "ready");
    this.update({ attachments: this.state.attachments.filter(keep) });
  }
  private async upload(attachment: Attachment): Promise<void> {
    if (!attachment.resourceId) return;
    const controller = new AbortController();
    this.uploads.set(attachment.id, controller);
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    this.patchAttachment(attachment, { state: "uploading", error: undefined });
    const result = await Result.tryPromise({
      try: () =>
        this.session.upload(
          attachment.resourceId!,
          attachment.file,
          (progress) => this.patchAttachment(attachment, { progress }),
          signal,
        ),
      catch: captureTuiException,
    });
    const failure = result.match({ ok: () => undefined, err: (error) => error });
    this.uploads.delete(attachment.id);
    if (failure && Panic.is(failure)) rethrowTuiDefect(failure);
    if (failure) {
      this.patchAttachment(attachment, { state: "failed", error: safeText(failure.message) });
      return;
    }
    this.patchAttachment(attachment, { state: "ready", progress: 1 });
    this.releaseCompletedUploads();
  }
  retryUpload(id: string): void {
    const attachment = this.state.attachments.find((item) => item.id === id);
    if (attachment?.state === "failed") this.run(this.upload(attachment));
  }
  async send(): Promise<boolean> {
    const rpc = this.session.client.rpc;
    if (!rpc || this.state.submitting) return false;
    const text = this.state.draft;
    const files = this.state.attachments.filter((item) => !item.sent);
    if (!text.trim() && !files.length) return false;
    if (text.length > 65_536) {
      this.update({ error: "Messages can contain at most 65,536 characters." });
      return false;
    }
    const matches =
      this.state.catalog?.commands.filter(
        (command) => text.trim() === `/${command.name}` || text.startsWith(`/${command.name} `),
      ) ?? [];
    if (matches.length > 1) {
      this.update({ error: "Ambiguous command. Rename duplicate commands in configuration." });
      return false;
    }
    const command = matches[0];
    if (command?.kind === "builtin") {
      if (command.id === "cancel") await this.cancel();
      if (command.id === "model")
        this.update({
          notice:
            "Use :model <id>. Models: " +
            this.state.catalog?.models.map((model) => model.id).join(", "),
        });
      this.update({ draft: "" });
      return true;
    }
    const skillIds =
      this.state.catalog?.skills
        .filter((skill) => hasSkill(text, skill.name))
        .map((skill) => skill.id) ?? [];
    this.update({ submitting: true, error: undefined });
    const thread = this.currentThread();
    const threadId = this.state.selected;
    if (!threadId || !thread?.capabilities.edit) {
      this.update({ submitting: false, error: "This conversation is read-only." });
      return false;
    }
    if (!this.session.client.thread(threadId).checkpoint) {
      const replay = await this.attempt(() => rpc.threads.sync({ threadId }));
      if (replay) this.session.client.thread(threadId).replay(replay);
    }
    const checkpoint = this.session.client.thread(threadId).checkpoint;
    if (!checkpoint) {
      this.update({ submitting: false, error: "Connect before sending." });
      return false;
    }
    for (const file of files) {
      if (file.resourceId) continue;
      const resource = await this.attempt(() =>
        rpc.resources.reserve({
          threadId,
          commandId: file.id,
          name: file.name,
          size: file.file.size,
          mediaType: file.file.type || "application/octet-stream",
        }),
      );
      if (!resource) {
        this.update({ submitting: false });
        return false;
      }
      this.patchAttachment(file, { resourceId: resource.id });
      this.run(this.upload(file));
    }
    const active = !!thread.activeRunId;
    const mode = deliveryMode(active, this.state.mode, command?.kind === "custom");
    const input: NativeInput = {
      threadId,
      commandId: crypto.randomUUID(),
      historyGeneration: checkpoint.historyGeneration,
      text,
      mode,
      attachmentIds: files.map((file) => file.resourceId!),
      skillIds,
      modelId: mode === "steer" ? undefined : this.state.modelId,
      command:
        command?.kind === "custom"
          ? { id: command.id, arguments: text.slice(command.name.length + 2) }
          : undefined,
    };
    const outcome = await this.session.client.submit(input);
    if (outcome.kind === "rejected") {
      this.update({ submitting: false, error: outcome.error.message });
      return false;
    }
    for (const file of files) file.sent = true;
    this.releaseCompletedUploads();
    this.update({
      submitting: false,
      draft: this.state.draft === text ? "" : this.state.draft,
      attachments: [...this.state.attachments],
      uncertainId: outcome.kind === "uncertain" ? outcome.commandId : undefined,
      notice:
        outcome.kind === "uncertain"
          ? "Send not confirmed. :retry safely checks the same command."
          : undefined,
    });
    await this.refreshQueue();
    return true;
  }
  async retrySend(): Promise<void> {
    if (!this.state.uncertainId) return;
    const outcome = await this.session.client.retry(this.state.uncertainId);
    if (outcome.kind === "accepted")
      this.update({ uncertainId: undefined, notice: "Send confirmed." });
    if (outcome.kind === "rejected") this.update({ error: outcome.error.message });
  }
  private mutation() {
    const threadId = this.state.selected;
    const checkpoint = threadId ? this.session.client.thread(threadId).checkpoint : undefined;
    return threadId && checkpoint
      ? {
          threadId,
          commandId: crypto.randomUUID(),
          historyGeneration: checkpoint.historyGeneration,
        }
      : undefined;
  }
  async cancel(): Promise<void> {
    const input = this.mutation();
    const rpc = this.session.client.rpc;
    if (!input || !rpc) return;
    await this.attempt(() =>
      rpc.runs.cancel({ ...input, runId: this.currentThread()?.activeRunId }),
    );
    await this.refreshQueue();
  }
  async refreshQueue(): Promise<void> {
    const threadId = this.state.selected;
    const rpc = this.session.client.rpc;
    if (!threadId || !rpc) return;
    const queue = await this.attempt(() => rpc.runs.queue({ threadId }));
    if (queue && this.state.selected === threadId) this.update({ queue: queue.items });
  }
  async removeQueued(inputId: string): Promise<void> {
    const input = this.mutation();
    const rpc = this.session.client.rpc;
    if (!input || !rpc) return;
    await this.attempt(() => rpc.runs.removeQueued({ ...input, inputId }));
    await this.refreshQueue();
  }
  dispose(): void {
    this.lifetime.abort();
    this.unsubscribe();
    this.unsubscribeThread?.();
    this.listeners.clear();
  }
}

export function deliveryMode(
  active: boolean,
  mode: "steer" | "followup",
  custom: boolean,
): NativeInput["mode"] {
  if (!active) return "prompt";
  if (custom) return "followup";
  return mode;
}
export function hasSkill(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)(?:\\$|/skill:)${escaped}(?=$|[^\\p{L}\\p{N}_-])`, "u").test(text);
}
