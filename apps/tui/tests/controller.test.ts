import { expect, test } from "bun:test";
import {
  DisplayCatalogCache,
  NativeThreadStore,
  type NativeClient,
  type ClientEvent,
} from "@stanley2058/lilac-client";
import type { NativeInput, NativeThread } from "@stanley2058/lilac-client-protocol";
import type { TuiSession } from "../src/session.ts";
import { TuiController } from "../src/controller.ts";

export function controllerFixture() {
  const store = new NativeThreadStore();
  store.replay({
    kind: "window",
    checkpoint: {
      protocolVersion: 1,
      historyGeneration: 0,
      projectionRevision: 0,
      cursor: "cursor",
    },
    slots: [],
  });
  const listeners = new Set<(event: ClientEvent) => void>();
  const thread: NativeThread = {
    id: "thread",
    title: "Fixture",
    starterId: "owner",
    archived: false,
    updatedAt: 0,
    revision: 0,
    capabilities: { read: true, edit: true, share: true },
  };
  const submitted: NativeInput[] = [];
  let canceled = 0;
  const catalogs = new DisplayCatalogCache();
  const scope = {
    installationId: "fixture",
    principalId: "owner",
    protocolVersion: 1 as const,
    projectionVersion: 1 as const,
  };
  const catalog = {
    revision: "catalog",
    models: [{ id: "model", label: "Model" }],
    commands: [{ id: "command", name: "status", kind: "custom" as const, description: "Status" }],
    skills: [{ id: "skill", name: "Review", source: "repo", description: "Review" }],
  };
  catalogs.put(scope, catalog);
  const bootstrap = {
    installationId: "fixture",
    viewer: {
      id: "owner",
      displayName: "Owner",
      role: "owner" as const,
      toolMode: "full" as const,
    },
    threads: { items: [thread] },
    catalog: { kind: "catalog" as const, catalog },
    catalogCursor: "catalogCursor",
  };
  const rpc = {
    threads: {
      get: async () => thread,
      create: async () => thread,
      list: async () => ({ items: [thread] }),
    },
    resources: {
      reserve: async () => ({
        id: "resource",
        name: "file",
        mediaType: "image/png",
        size: 5,
        state: "pending",
      }),
    },
    runs: {
      queue: async () => ({ items: [] }),
      cancel: async () => {
        canceled++;
        return { ok: true };
      },
    },
  };
  const client = {
    catalogs,
    rpc,
    thread: () => store,
    subscribe: (listener: (event: ClientEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: async () => {
      for (const listener of listeners) listener({ kind: "bootstrap", bootstrap });
    },
    selectThread: async () => {},
    hydrate: async () => {},
    submit: async (input: NativeInput) => {
      submitted.push(input);
      return {
        kind: "accepted",
        receipt: { inputId: "input", messageId: "message", state: "uploading" },
      };
    },
  } as unknown as NativeClient;
  const upload = Promise.withResolvers<void>();
  const session: TuiSession = {
    client,
    scope,
    initial: bootstrap,
    upload: () => upload.promise,
    logout: async () => {},
    dispose: async () => {},
  };
  return {
    controller: new TuiController(session),
    session,
    thread,
    store,
    submitted,
    upload,
    canceled: () => canceled,
  };
}

test("submits accepted input before attachment transfer finishes and keeps composer editable", async () => {
  const f = controllerFixture();
  await f.controller.start("thread");
  f.controller.attach(new Blob(["image"], { type: "image/png" }), "image.png");
  f.controller.update({ draft: "look" });
  expect(await f.controller.send()).toBe(true);
  expect(f.submitted[0]?.attachmentIds).toEqual(["resource"]);
  expect(f.controller.state.attachments[0]?.state).toBe("uploading");
  expect(f.controller.state.draft).toBe("");
  f.controller.update({ draft: "another message" });
  expect(f.controller.state.draft).toBe("another message");
  const finished = Promise.withResolvers<void>();
  const off = f.controller.subscribe(() => {
    if (f.controller.state.attachments[0]?.state === "ready") finished.resolve();
  });
  f.upload.resolve();
  await finished.promise;
  off();
  f.controller.dispose();
});

test("active custom commands preserve invocation and queue as followups", async () => {
  const f = controllerFixture();
  f.thread.activeRunId = "run";
  await f.controller.start("thread");
  f.controller.update({ draft: "/status more", modelId: "model", mode: "steer" });
  await f.controller.send();
  expect(f.submitted[0]?.mode).toBe("followup");
  expect(f.submitted[0]?.command).toEqual({ id: "command", arguments: "more" });
  expect(f.submitted[0]?.modelId).toBe("model");
  f.controller.dispose();
});

test("selected thread remains editable when search replaces list rows", async () => {
  const f = controllerFixture();
  await f.controller.start("thread");
  f.controller.update({ threads: [], draft: "still here" });
  expect(await f.controller.send()).toBe(true);
  expect(f.submitted[0]?.threadId).toBe("thread");
  f.controller.dispose();
});

test("direct startup loads selected metadata outside the bootstrap list", async () => {
  const f = controllerFixture();
  f.session.initial.threads.items = [];
  await f.controller.start("thread");
  expect(f.controller.currentThread()?.id).toBe("thread");
  f.controller.update({ draft: "direct prompt" });
  expect(await f.controller.send()).toBe(true);
  f.controller.dispose();
});

test("background controller defects reach the owned UI supervisor unchanged", async () => {
  const { Panic } = await import("better-result");
  const { controller, session } = controllerFixture();
  controller.dispose();
  const failed = Promise.withResolvers<Error>();
  const owned = new TuiController(session, (error) => failed.resolve(error));
  const panic = new Panic({ message: "fixture defect" });
  owned.run(owned.attempt(() => Promise.reject(panic)));
  expect(await failed.promise).toBe(panic);
  owned.dispose();
});

test("draft updates retain the history revision", () => {
  const { controller } = controllerFixture();
  const historyVersion = controller.state.historyVersion;
  controller.update({ draft: "typing" });
  expect(controller.state.historyVersion).toBe(historyVersion);
  controller.update({ slotIds: [] });
  expect(controller.state.historyVersion).toBe(historyVersion + 1);
  controller.dispose();
});
