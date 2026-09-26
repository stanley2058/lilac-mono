import type { NativeReferences } from "./references";
import { resolveLinkPreview } from "./link-preview";
import type { NativeLiveFileService } from "./resources-live";
import type { NativeSubagents } from "./subagents";
import { randomUUID } from "node:crypto";
import type {
  BootstrapReply,
  ReplayReply,
  TurnSlot,
  LiveUpdate,
  CatalogEvent,
  NativeRpcInputs,
  NativeUser,
  NativeThread,
  ResourceDisplay,
  ThreadEvent,
} from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import type { DurableResolvedModelRequest } from "@stanley2058/lilac-utils";
import type { NativeAuthenticator, NativePrincipal } from "./auth";
import type { NativeClerkAuthenticator } from "./auth-clerk";
import type { NativeCatalogService } from "./catalogs";
import type { NativeUploadRecord, NativeUser as StoredUser } from "./codec";
import { agentIdentity, nativeUserDisplay } from "./identity";
import type { NativeConfigService } from "./config-service";
import { NativeStoreFailure, nativeFailure } from "./errors";
import type { NativeExecution } from "./execution";
import type { NativeResourceService } from "./resources";
import type { NativeRpcServices } from "./rpc";
import type { NativeExternalThreads } from "./search-external";
import type { NativeStore } from "./store";
import type { NativeSearchStore } from "./store-search";
import type { NativeSurfaceStore } from "./store-surface";

export type NativeRpcServiceOptions = {
  references?: Pick<NativeReferences, "resolve" | "read" | "range">;
  files?: Pick<NativeLiveFileService, "resolve">;
  subagents?: Pick<NativeSubagents, "list" | "read">;
  store: NativeStore;
  auth: NativeAuthenticator;
  installationId: string;
  catalogs: Pick<NativeCatalogService, "get" | "subscribe">;
  config: Pick<NativeConfigService, "read" | "save" | "reloadMcp">;
  execution: Pick<NativeExecution, "kick" | "cancel" | "rewind" | "deleteThread">;
  resources: Pick<NativeResourceService, "reserve">;
  search: Pick<NativeSearchStore, "searchMessages">;
  external: Pick<NativeExternalThreads, "list" | "read">;
  surface: Pick<
    NativeSurfaceStore,
    "markTurnRead" | "setReaction" | "invokeAction" | "personalizeMessage" | "personalizePart"
  >;
  profileProvider?: Pick<NativeClerkAuthenticator, "lookupUser" | "updateDisplayName">;
  lookupUser?: NativeClerkAuthenticator["lookupUser"];
  resolveModel: (modelId?: string) => Result<DurableResolvedModelRequest, Error>;
};

export function nativeViewer(user: StoredUser): NativeUser {
  return nativeUserDisplay(user);
}

function displayResource(upload: NativeUploadRecord): ResourceDisplay {
  return {
    id: upload.id,
    name: upload.filename,
    mediaType: upload.mediaType,
    size: upload.size,
    state: upload.state,
  };
}

function summarySignature(thread: NativeThread): string {
  return JSON.stringify([
    thread.id,
    thread.title,
    thread.modelId,
    thread.archived,
    thread.capabilities,
    thread.starterDisplayName,
    thread.starterAvatarUrl,
    thread.displayStatus,
  ]);
}

function offsetCursor(cursor?: string): Result<number, Error> {
  if (cursor === undefined) return Result.ok(0);
  const offset = Number(cursor);
  if (!/^\d+$/u.test(cursor) || !Number.isSafeInteger(offset))
    return Result.err(nativeFailure("invalid", "Invalid page cursor"));
  return Result.ok(offset);
}

class CoalescedWake {
  private pending = true;
  private resolve: (() => void) | undefined;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly abort = () => this.notify();

  constructor(
    subscribe: (notify: () => void) => () => void,
    private readonly signal?: AbortSignal,
  ) {
    this.unsubscribe = subscribe(() => this.notify());
    this.timer = setInterval(() => this.notify(), 30_000);
    this.timer.unref();
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  notify(): void {
    this.pending = true;
    this.resolve?.();
    this.resolve = undefined;
  }

  async wait(): Promise<void> {
    if (!this.pending && !this.signal?.aborted)
      await new Promise<void>((resolve) => {
        this.resolve = resolve;
      });
    this.pending = false;
  }

  [Symbol.dispose](): void {
    this.unsubscribe();
    clearInterval(this.timer);
    this.signal?.removeEventListener("abort", this.abort);
    this.notify();
  }
}

export function createNativeRpcServices(options: NativeRpcServiceOptions): NativeRpcServices {
  const { store, auth, catalogs, config, execution, resources, search, external } = options;
  let catalogCursor = randomUUID();
  store.subscribe(() => {
    catalogCursor = randomUUID();
  });
  catalogs.subscribe(() => {
    catalogCursor = randomUUID();
  });

  function catalog(principal: NativePrincipal, revision?: string) {
    return store
      .getUser(principal.userId)
      .map((user) => catalogs.get({ key: `${user.id}_${user.toolMode}` }, revision));
  }

  function generation(
    principal: NativePrincipal,
    input: { threadId: string; historyGeneration: number },
  ) {
    return store.authorizeThread(principal.userId, input.threadId, true).andThen((thread) => {
      if (thread.historyGeneration !== input.historyGeneration)
        return Result.err(nativeFailure("stale", "Thread history changed"));
      return Result.ok(thread);
    });
  }

  function modelChoice(principal: NativePrincipal, modelId?: string): Result<void, Error> {
    if (!modelId) return Result.ok();
    return catalog(principal).andThen((reply) => {
      if (reply.kind !== "catalog" || !reply.catalog.models.some((model) => model.id === modelId))
        return Result.err(nativeFailure("invalid", "Configured model is unavailable"));
      return Result.ok();
    });
  }

  function inputSelections(
    principal: NativePrincipal,
    input: NativeRpcInputs["inputs"]["submit"],
  ): Result<void, Error> {
    return Result.gen(function* () {
      yield* modelChoice(principal, input.modelId);
      const reply = yield* catalog(principal);
      if (reply.kind !== "catalog")
        return Result.err(nativeFailure("invalid", "Input catalog is unavailable"));
      for (const skillId of input.skillIds) {
        if (!reply.catalog.skills.some((skill) => skill.id === skillId))
          return Result.err(nativeFailure("invalid", "Selected skill is unavailable"));
      }
      if (
        input.command &&
        !reply.catalog.commands.some(
          (command) => command.kind === "custom" && command.id === input.command?.id,
        )
      )
        return Result.err(nativeFailure("invalid", "Selected command is unavailable"));
      return Result.ok();
    });
  }

  function personalizeSlots(
    principal: NativePrincipal,
    threadId: string,
    slots: TurnSlot[],
  ): Result<TurnSlot[], Error> {
    return Result.all(
      slots.map((slot): Result<TurnSlot, Error> => {
        if (slot.kind !== "ready") return Result.ok(slot);
        return Result.all(
          slot.messages.map((message) =>
            options.surface.personalizeMessage(principal.userId, threadId, message),
          ),
        ).map((messages) => ({ ...slot, messages }));
      }),
    );
  }

  function personalizeChange(
    principal: NativePrincipal,
    threadId: string,
    change: LiveUpdate["changes"][number],
  ): Result<LiveUpdate["changes"][number], Error> {
    switch (change.kind) {
      case "insert":
        return Result.all(
          change.slot.messages.map((message) =>
            options.surface.personalizeMessage(principal.userId, threadId, message),
          ),
        ).map((messages) => ({ ...change, slot: { ...change.slot, messages } }));
      case "append-message":
        return options.surface
          .personalizeMessage(principal.userId, threadId, change.message)
          .map((message) => ({ ...change, message }));
      case "set-part":
        return options.surface
          .personalizePart(principal.userId, threadId, change.messageId, change.part)
          .map((part) => ({ ...change, part }));
      default:
        return Result.ok(change);
    }
  }

  function personalizeReplay(
    principal: NativePrincipal,
    threadId: string,
    reply: ReplayReply,
  ): Result<ReplayReply, Error> {
    switch (reply.kind) {
      case "window":
        return personalizeSlots(principal, threadId, reply.slots).map((slots) => ({
          ...reply,
          slots,
        }));
      case "delta":
        return Result.all(
          reply.changes.map((change) => personalizeChange(principal, threadId, change)),
        ).map((changes) => ({ ...reply, changes }));
      default:
        return Result.ok(reply);
    }
  }

  function syncThreadReplay(principal: NativePrincipal, input: NativeRpcInputs["threads"]["sync"]) {
    return store
      .sync(principal.userId, input.threadId, input.checkpoint)
      .andThen((reply) => personalizeReplay(principal, input.threadId, reply));
  }

  function selectedThread(
    principal: NativePrincipal,
    input: NativeRpcInputs["bootstrap"]["get"],
  ): Result<Pick<BootstrapReply, "selectedThread" | "selectedThreadUnavailable">, Error> {
    if (!input.threadId) return Result.ok({});
    return syncThreadReplay(principal, { threadId: input.threadId, checkpoint: input.checkpoint })
      .map((reply) => ({ selectedThread: reply }))
      .tryRecover((error) => {
        if (
          error instanceof NativeStoreFailure &&
          (error.code === "forbidden" || error.code === "not-found")
        )
          return Result.ok({ selectedThreadUnavailable: true as const });
        return Result.err(error);
      });
  }

  async function* watchThread(
    principal: NativePrincipal,
    input: NativeRpcInputs["threads"]["watch"],
    signal?: AbortSignal,
  ): AsyncGenerator<ThreadEvent, void, void> {
    using wake = new CoalescedWake(
      (notify) =>
        store.subscribe((threadId) => {
          if (!threadId || threadId === input.threadId) notify();
        }),
      signal,
    );
    let checkpoint = input.checkpoint;
    let first = true;
    let summary: string | undefined;
    const receipts = new Map<string, string>();
    while (!signal?.aborted) {
      await wake.wait();
      if (signal?.aborted) return;
      const accessible = Result.gen(function* () {
        yield* auth.checkSession(principal);
        return store.getThread(principal.userId, input.threadId);
      }).match({ ok: (thread) => thread, err: () => null });
      if (accessible === null) {
        yield { kind: "revoked" };
        return;
      }
      const reply = syncThreadReplay(principal, { threadId: input.threadId, checkpoint }).match({
        ok: (value) => value,
        err: () => null,
      });
      if (reply === null) {
        yield { kind: "revoked" };
        return;
      }
      const afterRevision =
        checkpoint?.historyGeneration === reply.checkpoint.historyGeneration
          ? checkpoint.projectionRevision
          : undefined;
      const changedInputs = store
        .listInputReceipts(principal.userId, input.threadId, { afterRevision })
        .match({ ok: (items) => items, err: () => [] });
      checkpoint = reply.checkpoint;
      if (first || reply.kind !== "unchanged") yield { kind: "replay", reply };
      if (signal?.aborted) return;
      const signature = summarySignature(accessible);
      if (summary !== signature && !first) {
        const current = auth
          .checkSession(principal)
          .andThen(() => store.getThread(principal.userId, input.threadId))
          .match({ ok: (thread) => thread, err: () => null });
        if (current === null) {
          yield { kind: "revoked" };
          return;
        }
        yield { kind: "thread", thread: current };
      }
      summary = signature;
      first = false;
      for (const changed of changedInputs) {
        if (signal?.aborted) return;
        const current = Result.gen(function* () {
          yield* auth.checkSession(principal);
          const thread = yield* store.authorizeThread(principal.userId, input.threadId);
          if (thread.historyGeneration !== reply.checkpoint.historyGeneration)
            return Result.ok(null);
          const record = yield* store.getInput(changed.inputId);
          if (record.historyGeneration !== thread.historyGeneration) return Result.ok(null);
          return Result.ok({
            inputId: record.id,
            messageId: record.messageId,
            turnId: record.turnId,
            runId: record.runId,
            state: record.state,
          });
        }).match({
          ok: (receipt) => ({ receipt, revoked: false }),
          err: () => ({ receipt: null, revoked: true }),
        });
        if (current.revoked) {
          yield { kind: "revoked" };
          return;
        }
        if (!current.receipt) {
          wake.notify();
          break;
        }
        const receiptKey = JSON.stringify(current.receipt);
        if (receipts.get(current.receipt.inputId) === receiptKey) continue;
        receipts.delete(current.receipt.inputId);
        receipts.set(current.receipt.inputId, receiptKey);
        if (receipts.size > 256) {
          const oldest = receipts.keys().next().value;
          if (oldest !== undefined) receipts.delete(oldest);
        }
        yield { kind: "input", receipt: current.receipt };
      }
    }
  }

  async function* watchCatalog(
    principal: NativePrincipal,
    cursor: string,
    signal?: AbortSignal,
  ): AsyncGenerator<CatalogEvent, void, void> {
    let resync = cursor !== catalogCursor;
    let catalogChanged = false;
    const pending = new Set<string>();
    const visible = new Map(
      store.listThreads(principal.userId, { limit: 100, excludeSettled: true }).match({
        ok: (threads) =>
          threads.map((thread) => [thread.id, catalogThreadSignature(thread)] as const),
        err: () => [],
      }),
    );
    using wake = new CoalescedWake((notify) => {
      const stopCatalog = catalogs.subscribe(() => {
        catalogChanged = true;
        notify();
      });
      const stopStore = store.subscribe((threadId) => {
        if (
          threadId &&
          !visible.has(threadId) &&
          !store
            .authorizeThread(principal.userId, threadId)
            .match({ ok: () => true, err: () => false })
        )
          return;
        if (!threadId || pending.size >= 100) {
          resync = true;
          pending.clear();
        }
        if (threadId && !resync) pending.add(threadId);
        notify();
      });
      return () => {
        stopCatalog();
        stopStore();
      };
    }, signal);
    while (!signal?.aborted) {
      await wake.wait();
      if (signal?.aborted) return;
      const accessible = auth
        .checkSession(principal)
        .andThen(() => store.getUser(principal.userId))
        .match({ ok: () => true, err: () => false });
      if (!accessible) return;
      if (catalogChanged) {
        catalogChanged = false;
        const next = catalog(principal).match({ ok: (reply) => reply, err: () => null });
        if (next?.kind === "catalog")
          yield {
            kind: "catalog-invalidated",
            revision: next.catalog.revision,
            cursor: catalogCursor,
          };
        if (resync || pending.size > 0) wake.notify();
        continue;
      }
      if (resync) {
        resync = false;
        pending.clear();
        yield { kind: "resync", cursor: catalogCursor };
        continue;
      }
      for (const threadId of pending) {
        pending.delete(threadId);
        if (
          signal?.aborted ||
          !auth.checkSession(principal).match({ ok: () => true, err: () => false })
        )
          return;
        const visibleToClient = store.getThreadRecord(threadId).match({
          ok: (record) =>
            principal.provider === "operator"
              ? record.ephemeral?.sessionId === principal.sessionId
              : !record.ephemeral,
          err: () => true,
        });
        if (!visibleToClient) continue;
        const thread = store
          .getThread(principal.userId, threadId)
          .match({ ok: (value) => value, err: () => null });
        if (thread === null) {
          if (!visible.delete(threadId)) continue;
          yield { kind: "removed", threadId, cursor: catalogCursor };
          continue;
        }
        const signature = catalogThreadSignature(thread);
        if (visible.get(threadId) === signature) continue;
        const settled = store
          .isSidebarThreadSettled(principal.userId, threadId)
          .match({ ok: (value) => value, err: () => false });
        if (settled) {
          yield { kind: "resync", cursor: catalogCursor };
          continue;
        }
        visible.set(threadId, signature);
        if (visible.size > 1000) {
          const oldest = visible.keys().next().value;
          if (oldest !== undefined) visible.delete(oldest);
        }
        yield { kind: "thread", thread, cursor: catalogCursor };
      }
    }
  }

  function catalogThreadSignature(thread: NativeThread): string {
    const activeRunId = store
      .getThreadRecord(thread.id)
      .match({ ok: (record) => record.activeRunId ?? "", err: () => "" });
    return `${summarySignature(thread)}_${activeRunId}`;
  }

  const success = () => ({ ok: true as const });
  return {
    links: {
      async preview(_principal, input, signal) {
        return Result.ok(await resolveLinkPreview(input.url, signal));
      },
    },
    bootstrap: {
      get(principal, input) {
        return Result.gen(function* () {
          const viewer = yield* store.getUser(principal.userId);
          const items =
            principal.provider === "operator"
              ? []
              : yield* store.listThreads(principal.userId, { limit: 30, excludeSettled: true });
          const lastListed = items.at(-1);
          const nextCursor =
            items.length === 30 && lastListed
              ? `${lastListed.updatedAt}_${lastListed.id}`
              : undefined;
          const displayCatalog = yield* catalog(principal, input.catalogRevision);
          const selected = yield* selectedThread(principal, input);
          if (
            selected.selectedThread &&
            input.threadId &&
            !items.some((thread) => thread.id === input.threadId)
          )
            items.push(yield* store.getThread(principal.userId, input.threadId));
          return Result.ok({
            installationId: options.installationId,
            viewer: nativeViewer(viewer),
            threads: { items, ...(nextCursor ? { nextCursor } : {}) },
            catalog: displayCatalog,
            ...selected,
            catalogCursor,
          });
        });
      },
      watch(principal, input, signal) {
        return Result.ok(watchCatalog(principal, input.cursor, signal));
      },
    },
    sidebar: {
      preferences(principal) {
        return store.getSidebarPreferences(principal.userId);
      },
      configure(principal, input) {
        return store.configureSidebar(principal.userId, input);
      },
      list(principal, input) {
        return store.listSidebar(principal.userId, input);
      },
      move(principal, input) {
        return store.moveSidebarThread(principal.userId, input);
      },
    },
    threads: {
      get(principal, input) {
        return auth
          .checkSession(principal)
          .andThen(() => store.getThread(principal.userId, input.threadId));
      },
      list(principal, input) {
        return Result.gen(function* () {
          const limit = input.limit ?? 30;
          const items = yield* store.listThreads(principal.userId, {
            limit,
            cursor: input.cursor,
            archived: input.archived,
            excludeSettled: input.excludeSettled,
            query: input.query,
          });
          return Result.ok({
            items,
            ...(items.length === limit
              ? { nextCursor: `${items.at(-1)!.updatedAt}_${items.at(-1)!.id}` }
              : {}),
          });
        });
      },
      create(principal, input) {
        if (principal.provider === "operator")
          return Result.err(
            nativeFailure(
              "forbidden",
              "Operator conversations are managed by the terminal session",
            ),
          );
        return modelChoice(principal, input.modelId).andThen(() =>
          store.createThread(principal.userId, input),
        );
      },
      update(principal, input) {
        return modelChoice(principal, input.modelId).andThen(() =>
          store.updateThread(principal.userId, {
            ...input,
            revision: input.expectedRevision,
            commandId: randomUUID(),
          }),
        );
      },
      async delete(principal, input) {
        return Result.gen(async function* () {
          yield* Result.await(execution.deleteThread(principal.userId, input));
          return Result.ok(success());
        });
      },
      markRead(principal, input) {
        return options.surface
          .markTurnRead(principal.userId, input.threadId, input.turnId)
          .map(success);
      },
      sync(principal, input) {
        return syncThreadReplay(principal, input);
      },
      watch(principal, input, signal) {
        return store
          .authorizeThread(principal.userId, input.threadId)
          .map(() => watchThread(principal, input, signal));
      },
      hydrate(principal, input) {
        return store.hydrate(principal.userId, input).andThen((hydration) =>
          personalizeSlots(principal, input.threadId, hydration.slots).map((slots) => ({
            ...hydration,
            slots,
          })),
        );
      },
      turnPage(principal, input) {
        return Result.gen(function* () {
          const page = yield* store.turnPage(principal.userId, input);
          const messages = yield* Result.all(
            page.messages.map((message) =>
              options.surface.personalizeMessage(principal.userId, input.threadId, message),
            ),
          );
          if (!page.chunks) return Result.ok({ ...page, messages });
          const chunks = yield* Result.all(
            page.chunks.map((chunk) =>
              options.surface
                .personalizePart(principal.userId, input.threadId, chunk.messageId, chunk.part)
                .map((part) => ({ ...chunk, part })),
            ),
          );
          return Result.ok({ ...page, messages, chunks });
        });
      },
      async rewind(principal, input) {
        return Result.gen(async function* () {
          const rewound = yield* Result.await(
            execution.rewind(principal.userId, { ...input, revision: input.expectedRevision }),
          );
          const reply = yield* store.sync(principal.userId, input.threadId);
          return Result.ok({ text: rewound.text, checkpoint: reply.checkpoint });
        });
      },
    },
    actions: {
      invoke(principal, input) {
        return options.surface.invokeAction(principal.userId, input);
      },
    },
    reactions: {
      set(principal, input) {
        return options.surface
          .setReaction(principal.userId, input.threadId, input.messageId, input.emoji, input.active)
          .map(success);
      },
    },
    participants: {
      list(principal, input) {
        return store.listParticipants(principal.userId, input.threadId).map((items) => ({ items }));
      },
      set(principal, input) {
        return store.shareThread(principal.userId, { ...input, grant: input.role }).map(success);
      },
      remove(principal, input) {
        return store.shareThread(principal.userId, { ...input, grant: null }).map(success);
      },
    },
    profile: {
      async get(principal) {
        return Result.gen(async function* () {
          const user = yield* store.getUser(principal.userId);
          if (principal.provider !== "clerk") return Result.ok(nativeViewer(user));
          if (!options.profileProvider)
            return Result.err(nativeFailure("invalid", "Profile provider is unavailable"));
          const profile = yield* Result.await(options.profileProvider.lookupUser(user.providerId));
          const current = yield* store.getUser(user.id);
          if (
            current.displayName !== user.displayName ||
            current.providerAvatarUrl !== user.providerAvatarUrl ||
            current.avatar?.blob.sha256 !== user.avatar?.blob.sha256
          )
            return Result.ok(nativeViewer(current));
          const updated = yield* store.setUserProfile(user.id, {
            displayName: profile.displayName,
            providerAvatarUrl: profile.avatarUrl ?? null,
          });
          return Result.ok(nativeViewer(updated));
        });
      },
      async update(principal, input) {
        return Result.gen(async function* () {
          const user = yield* store.getUser(principal.userId);
          if (principal.provider !== "clerk")
            return store.setUserProfile(user.id, input).map(nativeViewer);
          if (!options.profileProvider)
            return Result.err(nativeFailure("invalid", "Profile provider is unavailable"));
          const profile = yield* Result.await(
            options.profileProvider.updateDisplayName(user.providerId, input.displayName),
          );
          const updated = yield* store.setUserProfile(user.id, {
            displayName: profile.displayName,
          });
          return Result.ok(nativeViewer(updated));
        });
      },
    },
    identity: {
      update(principal, input) {
        return store.setAgentIdentity(principal.userId, input).map(agentIdentity);
      },
    },
    users: {
      list(principal, input) {
        return store.listUsers(principal.userId, input);
      },
      async add(principal, input) {
        return Result.gen(async function* () {
          yield* store.requireOwner(principal.userId);
          if (!options.lookupUser || principal.provider !== "clerk")
            return Result.err(
              nativeFailure("forbidden", "Local authentication has one fixed owner"),
            );
          const provider = yield* Result.await(options.lookupUser(input.providerUserId));
          const existing = yield* store.findUserByProviderId(provider.providerUserId);
          if (existing) return Result.ok(nativeViewer(existing));
          const created = yield* store.upsertUser({
            id: randomUUID(),
            providerId: provider.providerUserId,
            displayName: provider.displayName,
            role: "participant",
            toolMode: input.toolMode,
          });
          return Result.ok(nativeViewer(created));
        });
      },
      setToolMode(principal, input) {
        return store.setToolMode(principal.userId, input.userId, input.toolMode).map(nativeViewer);
      },
    },
    inputs: {
      async submit(principal, input) {
        return Result.gen(async function* () {
          const existing = yield* store.lookupInputReceipt(principal.userId, input);
          if (existing) return Result.ok(existing);
          yield* inputSelections(principal, input);
          const thread = yield* store.authorizeThread(principal.userId, input.threadId, true);
          const resolvedModelRequest =
            input.mode === "steer" && !input.command
              ? undefined
              : yield* options.resolveModel(input.modelId ?? thread.modelId);
          const receipt = yield* store.acceptInput(principal.userId, input, {
            resolvedModelRequest,
          });
          return Result.ok(receipt);
        });
      },
    },
    runs: {
      async cancel(principal, input) {
        return Result.gen(async function* () {
          const thread = yield* generation(principal, input);
          const runId = input.runId ?? thread.activeRunId;
          if (input.runId && thread.activeRunId !== input.runId)
            return Result.err(nativeFailure("stale", "The active run changed"));
          yield* Result.await(execution.cancel(principal.userId, input.threadId, runId));
          return Result.ok(success());
        });
      },
      queue(principal, input) {
        return store.listQueuedInputs(principal.userId, input.threadId).map((items) => ({ items }));
      },
      async removeQueued(principal, input) {
        return Result.gen(async function* () {
          yield* generation(principal, input);
          const pending = yield* store.getInput(input.inputId);
          if (pending.threadId !== input.threadId)
            return Result.err(nativeFailure("forbidden", "Input belongs to another thread"));
          yield* store.removeInput(principal.userId, input.inputId);
          return Result.ok(success());
        });
      },
    },
    catalogs: {
      get(principal, input) {
        return catalog(principal, input.revision);
      },
    },
    files: {
      resolve: (principal, input, signal) =>
        options.files
          ? options.files.resolve(principal.userId, input.threadId, input.path, signal)
          : Result.err(nativeFailure("not-found", "File browsing is unavailable")),
    },
    resources: {
      reserve(principal, input) {
        return resources
          .reserve(principal.userId, {
            threadId: input.threadId,
            filename: input.name,
            mediaType: input.mediaType,
            size: input.size,
            commandId: input.commandId,
          })
          .map(displayResource);
      },
      get(principal, input) {
        return store.readUpload(principal.userId, input.resourceId).map(displayResource);
      },
    },
    config: {
      readDeployment(principal) {
        return store.readDeployment(principal.userId);
      },
      setDeployment(principal, input) {
        return store.setDeployment(principal.userId, input);
      },
      read(principal, input) {
        return config.read(principal.userId, input.kind);
      },
      save(principal, input) {
        return config.save(principal.userId, input);
      },
      async reloadMcp(principal) {
        return (await config.reloadMcp(principal.userId)).map((outcomes) => ({
          servers: outcomes.map((outcome) => ({
            name: outcome.serverId,
            state: outcome.result,
            reconciliation: outcome.reconciliation,
            ...(outcome.error ? { error: outcome.error } : {}),
          })),
        }));
      },
    },
    references: {
      range: (principal, target) =>
        options.references?.range(principal.userId, target) ??
        Result.err(nativeFailure("not-found", "References unavailable")),
      resolve: (principal, target) =>
        options.references?.resolve(principal.userId, target) ??
        Result.err(nativeFailure("not-found", "References unavailable")),
      read: (principal, input) =>
        options.references?.read(principal.userId, input) ??
        Result.err(nativeFailure("not-found", "References unavailable")),
    },
    search: {
      query(principal, input) {
        return Result.gen(function* () {
          const limit = input.limit ?? 30;
          const offset = yield* offsetCursor(input.cursor);
          const rows = yield* search.searchMessages(principal.userId, {
            query: input.query,
            threadId: input.threadId,
            limit: limit + 1,
            offset,
          });
          return Result.ok({
            items: rows.slice(0, limit).map((row) => ({
              threadId: row.threadId,
              turnId: row.turnId,
              title: row.title,
              excerpt: row.text.slice(0, 2048),
              surface: "native" as const,
            })),
            ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
          });
        });
      },
    },
    subagents: {
      list: (principal, input) =>
        options.subagents?.list(principal.userId, input) ?? Result.ok({ items: [] }),
      read: (principal, input) =>
        options.subagents?.read(principal.userId, input) ??
        Result.err(nativeFailure("not-found", "Subagent not found")),
    },
    external: {
      list(principal, input) {
        return external.list(principal.userId, input);
      },
      read(principal, input) {
        return external.read(principal.userId, input);
      },
    },
  };
}
