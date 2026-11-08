import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, jest } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeContract, replayReplySchema } from "@stanley2058/lilac-client-protocol";
import { QuestionService } from "../../question/question-service";
import { SqliteQuestionStore } from "../../question/question-store";
import { NativeStore } from "./store";
import { NativeQuestions } from "./questions";
import { nativeSurfaceProtocol } from "./native-protocol";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  jest.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "native-questions-"));
  const dbPath = join(dir, "native.db");
  let db = new Database(dbPath);
  const store = new NativeStore(db);
  store.initialize().unwrap();
  for (const [id, role] of [
    ["owner", "owner"],
    ["alice", "participant"],
    ["bob", "participant"],
  ] as const)
    store.upsertUser({ id, providerId: id, displayName: id, role, toolMode: "full" }).unwrap();
  const thread = store.createThread("alice", { commandId: "create" }).unwrap();
  const receipt = store
    .acceptInput("alice", {
      threadId: thread.id,
      commandId: "send",
      historyGeneration: 0,
      mode: "prompt",
      text: "Ask me",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  const request = store.getInput(receipt.inputId).unwrap();
  const deliveryPath = join(dir, "delivery.db");
  const delivery = new Database(deliveryPath);
  delivery.run(
    "CREATE TABLE request_delivery_records (request_delivery_id TEXT PRIMARY KEY NOT NULL) STRICT",
  );
  delivery.run("INSERT INTO request_delivery_records VALUES (?)", [request.deliveryId]);
  delivery.close();
  const questionStore = new SqliteQuestionStore({ dbPath: deliveryPath });
  const native = new NativeQuestions(store);
  const resolved = {
    platform: "native" as const,
    protocol: nativeSurfaceProtocol,
    question: native.port,
  };
  const service = new QuestionService({
    store: questionStore,
    surfaces: {
      entries: () => [resolved],
      resolve: (platform) => (platform === "native" ? resolved : null),
    },
    logger: { warn: () => {} },
  });
  (await service.start()).unwrap();
  cleanups.push(async () => {
    await service.stop();
    questionStore.close();
    db.close();
    rmSync(dir, { recursive: true });
  });
  const args = {
    requestDeliveryId: request.deliveryId,
    requestId: request.requestId,
    toolCallId: "ask",
    sessionId: thread.id,
    platform: "native" as const,
    userId: "alice",
    mode: "deferred" as const,
    questions: {
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Where?",
          options: [
            { id: "a", label: "A", description: "Use A" },
            { id: "b", label: "B", description: "Use B" },
          ],
        },
      ],
    },
  };
  return {
    store,
    native,
    service,
    questionStore,
    thread,
    args,
    request,
    db: () => db,
    reopen: () => {
      db.close();
      db = new Database(dbPath);
      const reopened = new NativeStore(db);
      reopened.initialize().unwrap();
      return { store: reopened, native: new NativeQuestions(reopened) };
    },
  };
}

function reply(threadId: string, messageId: string, token: string) {
  return {
    threadId,
    commandId: "answer",
    historyGeneration: 0,
    mode: "prompt" as const,
    text: "1",
    attachmentIds: [] as string[],
    skillIds: [],
    questionReply: { messageId, token },
  };
}

describe("native question wire", () => {
  test("deferred questions survive completion, service stop and database reopen; answer is atomic and idempotent", async () => {
    const f = await fixture();
    const handle = (await f.service.begin(f.args)).unwrap();
    const question = f.native
      .read("alice", { threadId: f.thread.id, messageId: handle.questionCallId })
      .unwrap();
    if (question.view.state !== "pending") throw new Error("Missing question");
    f.store.settleInput(f.request.id, "admitted").unwrap();
    f.store.markInputCompleted(f.request.id).unwrap();
    await f.service.cancelRequest(f.args.requestId);
    await f.service.stop();
    expect(f.service.listDeferred(f.args.requestId).unwrap()).toEqual([]);
    const reopened = f.reopen();
    expect(reopened.native.pending("alice", { threadId: f.thread.id }).unwrap()).toHaveLength(1);
    const input = reply(f.thread.id, handle.questionCallId, question.view.prompt.customToken);
    const receipt = reopened.store.acceptInput("alice", input).unwrap();
    expect(reopened.store.acceptInput("alice", input).unwrap()).toEqual(receipt);
    expect(reopened.store.acceptInput("alice", { ...input, commandId: "duplicate" }).isErr()).toBe(
      true,
    );
    expect(reopened.native.pending("alice", { threadId: f.thread.id }).unwrap()).toEqual([]);
    expect(
      reopened.native
        .read("alice", { threadId: f.thread.id, messageId: handle.questionCallId })
        .unwrap().view,
    ).toEqual({
      state: "answered",
      summary: { answers: [] },
      replyMessageId: receipt.messageId,
      replyInputId: receipt.inputId,
    });
    expect(
      replayReplySchema.safeParse(reopened.store.sync("alice", f.thread.id).unwrap()).success,
    ).toBe(true);
    expect(nativeContract.questions.pending).toBeDefined();
  });

  test("the sidebar shows needs input only to the respondent until the question is answered", async () => {
    const f = await fixture();
    const handle = (await f.service.begin(f.args)).unwrap();
    const question = f.native
      .read("alice", { threadId: f.thread.id, messageId: handle.questionCallId })
      .unwrap();
    if (question.view.state !== "pending") throw new Error("Missing question");
    f.store.settleInput(f.request.id, "admitted").unwrap();
    f.store.markInputCompleted(f.request.id).unwrap();
    expect(f.store.getThread("alice", f.thread.id).unwrap().displayStatus).toBe("input");
    expect(f.store.getThread("owner", f.thread.id).unwrap().displayStatus).not.toBe("input");
    f.store
      .acceptInput(
        "alice",
        reply(f.thread.id, handle.questionCallId, question.view.prompt.customToken),
      )
      .unwrap();
    expect(f.store.getThread("alice", f.thread.id).unwrap().displayStatus).not.toBe("input");
  });

  test("during a live run the respondent sees input and others see waiting once it parks", async () => {
    const f = await fixture();
    const handle = (await f.service.begin(f.args)).unwrap();
    const question = f.native
      .read("alice", { threadId: f.thread.id, messageId: handle.questionCallId })
      .unwrap();
    if (question.view.state !== "pending") throw new Error("Missing question");
    f.store.settleInput(f.request.id, "admitted").unwrap();
    f.store.setActiveRun(f.thread.id, 0, f.request.requestId).unwrap();
    const read = (user: string) => f.store.getThread(user, f.thread.id).unwrap();
    expect(read("alice")).toMatchObject({ displayStatus: "working", waitingOn: "input" });
    expect(read("owner").displayStatus).toBe("working");
    expect(read("owner").waitingOn).toBeUndefined();
    f.store.setRunWaiting(f.thread.id, f.request.requestId, true);
    expect(read("alice").waitingOn).toBe("input");
    expect(read("owner").waitingOn).toBe("other");
    expect(f.store.notificationContent("alice", f.thread.id).unwrap().body).toBe(
      "Needs your input",
    );
  });

  test("deferred calls never schedule the sync inactivity deadline", async () => {
    jest.useFakeTimers({ now: 0 });
    const f = await fixture();
    const handle = (await f.service.begin(f.args)).unwrap();
    jest.advanceTimersByTime(100 * 10 * 60 * 1000);
    expect(
      f.native.read("alice", { threadId: f.thread.id, messageId: handle.questionCallId }).unwrap()
        .view.state,
    ).toBe("pending");
  });

  test("startup interrupts persisted sync calls while preserving deferred questions", async () => {
    const f = await fixture();
    const old = (await f.service.begin(f.args)).unwrap();
    const question = f.native
      .read("alice", { threadId: f.thread.id, messageId: old.questionCallId })
      .unwrap();
    f.store.updateQuestion("alice", f.thread.id, { ...question, mode: "sync" }).unwrap();
    const deferred = (await f.service.begin({ ...f.args, toolCallId: "durable" })).unwrap();
    const reopened = f.reopen();
    reopened.native.recover().unwrap();
    expect(
      reopened.native
        .pending("alice", { threadId: f.thread.id })
        .unwrap()
        .map((q) => q.questionCallId),
    ).toEqual([deferred.questionCallId]);
    expect(
      reopened.native
        .read("alice", { threadId: f.thread.id, messageId: old.questionCallId })
        .unwrap().view.state,
    ).toBe("interrupted");
    const replay = (await reopened.native.begin(f.args)).unwrap();
    expect((await replay.completion).match({ ok: () => "ok", err: (error) => error._tag })).toBe(
      "QuestionInterrupted",
    );
  });

  test("sync dismissal reports cancellation", async () => {
    const f = await fixture();
    const handle = (await f.service.begin({ ...f.args, mode: "sync" })).unwrap();
    const question = f.native
      .read("alice", { threadId: f.thread.id, messageId: handle.questionCallId })
      .unwrap();
    if (question.view.state !== "pending") throw new Error("Missing question");
    f.native
      .dismiss("alice", {
        threadId: f.thread.id,
        messageId: handle.questionCallId,
        historyGeneration: 0,
        token: question.view.prompt.customToken,
      })
      .unwrap();
    expect((await handle.completion).match({ ok: () => "ok", err: (error) => error._tag })).toBe(
      "QuestionCancelled",
    );
  });

  test("question retries reject a changed respondent, request or retained pre-rewind card", async () => {
    const f = await fixture();
    (await f.service.begin(f.args)).unwrap();
    expect((await f.service.begin({ ...f.args, userId: "owner" })).isErr()).toBe(true);
    expect((await f.service.begin({ ...f.args, requestId: "different" })).isErr()).toBe(true);
    f.store.settleInput(f.request.id, "admitted").unwrap();
    f.store.markInputCompleted(f.request.id).unwrap();
    const second = f.store
      .acceptInput("alice", {
        threadId: f.thread.id,
        commandId: "second",
        historyGeneration: 0,
        mode: "prompt",
        text: "second",
        attachmentIds: [],
        skillIds: [],
      })
      .unwrap();
    const thread = f.store.getThreadRecord(f.thread.id).unwrap();
    f.store
      .beginRewind("alice", {
        threadId: thread.id,
        turnId: second.turnId!,
        commandId: "rewind",
        historyGeneration: 0,
        revision: thread.revision,
      })
      .unwrap();
    f.store.finishMutation(thread.id, 1).unwrap();
    expect((await f.service.begin(f.args)).isErr()).toBe(true);
  });

  test("invalid respondent, token, generation and attachment do not consume a question", async () => {
    const f = await fixture();
    const handle = (await f.service.begin(f.args)).unwrap();
    const question = f.native
      .read("alice", { threadId: f.thread.id, messageId: handle.questionCallId })
      .unwrap();
    if (question.view.state !== "pending") throw new Error("Missing question");
    const input = reply(f.thread.id, handle.questionCallId, question.view.prompt.customToken);
    f.store.shareThread("owner", { threadId: f.thread.id, userId: "bob", grant: "edit" }).unwrap();
    expect(f.store.acceptInput("bob", input).isErr()).toBe(true);
    expect(f.store.acceptInput("alice", { ...input, historyGeneration: 1 }).isErr()).toBe(true);
    expect(
      f.store
        .acceptInput("alice", {
          ...input,
          questionReply: { ...input.questionReply, token: "wrong" },
        })
        .isErr(),
    ).toBe(true);
    expect(f.store.acceptInput("alice", { ...input, attachmentIds: ["missing"] }).isErr()).toBe(
      true,
    );
    expect(f.native.pending("alice", { threadId: f.thread.id }).unwrap()).toHaveLength(1);
    f.native
      .dismiss("alice", {
        threadId: f.thread.id,
        messageId: handle.questionCallId,
        historyGeneration: 0,
        token: input.questionReply.token,
      })
      .unwrap();
    expect(f.native.pending("alice", { threadId: f.thread.id }).unwrap()).toEqual([]);
  });

  test("a failed input write rolls back question resolution and keeps the command retryable", async () => {
    const f = await fixture();
    const handle = (await f.service.begin(f.args)).unwrap();
    const question = f.native
      .read("alice", { threadId: f.thread.id, messageId: handle.questionCallId })
      .unwrap();
    if (question.view.state !== "pending") throw new Error("Missing question");
    const input = reply(f.thread.id, handle.questionCallId, question.view.prompt.customToken);
    f.db().run(
      "CREATE TRIGGER reject_question_reply BEFORE INSERT ON native_records WHEN NEW.kind='input' AND json_extract(NEW.data_json,'$.value.commandId')='answer' BEGIN SELECT RAISE(ABORT,'reject reply'); END",
    );
    expect(() => f.store.acceptInput("alice", input)).toThrow();
    expect(f.native.pending("alice", { threadId: f.thread.id }).unwrap()).toHaveLength(1);
    f.db().run("DROP TRIGGER reject_question_reply");
    expect(f.store.acceptInput("alice", input).isOk()).toBe(true);
    expect(f.native.pending("alice", { threadId: f.thread.id }).unwrap()).toHaveLength(0);
  });

  test("attachment-only input uses ordinary upload ownership and publication", async () => {
    const f = await fixture();
    const handle = (await f.service.begin(f.args)).unwrap();
    const question = f.native
      .read("alice", { threadId: f.thread.id, messageId: handle.questionCallId })
      .unwrap();
    if (question.view.state !== "pending") throw new Error("Missing question");
    const upload = f.store
      .reserveUpload("alice", {
        threadId: f.thread.id,
        filename: "reference.png",
        mediaType: "image/png",
        size: 10,
      })
      .unwrap();
    const input = {
      ...reply(f.thread.id, handle.questionCallId, question.view.prompt.customToken),
      text: "",
      attachmentIds: [upload.id],
    };
    expect(f.store.acceptInput("alice", input).isErr()).toBe(true);
    const claimed = f.store.claimUpload("alice", upload.id).unwrap();
    f.store
      .settleUpload(upload.id, {
        attempt: claimed.attempt,
        historyGeneration: 0,
        state: "ready",
        resourceUri: "resource://reference",
      })
      .unwrap();
    const accepted = f.store.acceptInput("alice", input).unwrap();
    expect(f.store.getInput(accepted.inputId).unwrap().attachmentIds).toEqual([upload.id]);
    expect(f.store.getUpload(upload.id).unwrap().published).toBe(true);
  });

  test("explicit sync completes with the freeform message and file references", async () => {
    const f = await fixture();
    const abort = new AbortController();
    const handle = (
      await f.service.begin({ ...f.args, mode: "sync", signal: abort.signal })
    ).unwrap();
    const question = f.native
      .read("alice", { threadId: f.thread.id, messageId: handle.questionCallId })
      .unwrap();
    if (question.view.state !== "pending") throw new Error("Missing question");
    f.store.setActiveRun(f.thread.id, 0, f.args.requestId).unwrap();
    const receipt = f.store
      .acceptInput("alice", {
        ...reply(f.thread.id, handle.questionCallId, question.view.prompt.customToken),
        mode: "followup",
      })
      .unwrap();
    expect(f.store.getInput(receipt.inputId).unwrap().mode).toBe("steer");
    abort.abort();
    expect((await handle.completion).unwrap()).toEqual([
      {
        questionId: handle.questionCallId,
        answer: { kind: "message", text: "1", messageId: receipt.messageId, attachmentIds: [] },
      },
    ]);
  });
});
