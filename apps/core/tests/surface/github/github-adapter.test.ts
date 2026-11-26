import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import { GithubApiError } from "../../../src/github/github-api";
import { GithubAuthFailed } from "../../../src/github/github-auth";
import { GITHUB_AGENT_COMMENT_MARKER } from "../../../src/github/github-comment-marker";
import {
  SurfaceInvalidInput,
  SurfaceMessageNotFound,
  SurfaceOperationPartiallyCompleted,
  SurfaceOperationUnsupported,
  SurfacePermissionDenied,
  SurfacePlatformMismatch,
  SurfaceRateLimited,
  SurfaceSessionMismatch,
  SurfaceUnavailable,
} from "../../../src/surface/adapter";
import {
  classifyGithubSurfaceError,
  GithubAdapter,
  type GithubAdapterApi,
} from "../../../src/surface/github/github-adapter";
import { createGithubWorkflowProgressPort } from "../../../src/surface/github/github-runtime-descriptor";

function createGithubApi(overrides: Partial<GithubAdapterApi> = {}): GithubAdapterApi {
  return {
    getIssue: async () => ({ title: "Issue", body: "Body" }),
    listIssueComments: async () => [],
    createIssueComment: async () => ({ id: 42 }),
    getIssueComment: async ({ commentId }) => ({ id: commentId, body: "Comment" }),
    editIssueComment: async () => undefined,
    deleteIssueComment: async () => undefined,
    createIssueReaction: async () => ({ id: 1 }),
    createIssueCommentReaction: async () => ({ id: 1 }),
    listIssueReactions: async () => [],
    listIssueCommentReactions: async () => [],
    deleteIssueReactionById: async () => undefined,
    deleteIssueCommentReactionById: async () => undefined,
    getGithubAppSlugOrNull: async () => null,
    ...overrides,
  };
}

describe("GitHub adapter contract failures", () => {
  it("returns a platform mismatch for a mismatched session platform", async () => {
    const adapter = new GithubAdapter();

    const result = await adapter.startOutput({ platform: "discord", channelId: "channel-1" });

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected start-output failure");
    expect(result.error).toBeInstanceOf(SurfacePlatformMismatch);
    expect(result.error).toMatchObject({
      operation: "start-output",
      refRole: "sessionRef",
      expectedPlatform: "github",
      receivedPlatform: "discord",
    });
  });

  it("rejects empty messages before invoking the GitHub SDK", async () => {
    const adapter = new GithubAdapter();

    const result = await adapter.sendMsg(
      { platform: "github", channelId: "owner/repo#1" },
      { text: "   " },
    );

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected send-message failure");
    expect(result.error).toBeInstanceOf(SurfaceInvalidInput);
    expect(result.error).toMatchObject({
      operation: "send-message",
      field: "content.text",
    });
  });

  it("rejects a reply target from another GitHub session", async () => {
    const result = await new GithubAdapter().startOutput(
      { platform: "github", channelId: "owner/repo#1" },
      { replyTo: { platform: "github", channelId: "owner/repo#2", messageId: "10" } },
    );

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected start-output failure");
    expect(result.error).toBeInstanceOf(SurfaceSessionMismatch);
    expect(result.error).toMatchObject({ operation: "start-output", refRole: "replyTo" });
  });

  it.each(["1e3", "+1000", "0x3e8", "01"])(
    "rejects non-canonical GitHub comment id %s",
    async (messageId) => {
      const result = await new GithubAdapter().readMsg({
        platform: "github",
        channelId: "owner/repo#1",
        messageId,
      });

      expect(result.status).toBe("error");
      if (result.status === "ok") throw new Error("expected read-message failure");
      expect(result.error).toBeInstanceOf(SurfaceInvalidInput);
      expect(result.error).toMatchObject({ operation: "read-message", field: "messageId" });
    },
  );
});

describe("GitHub adapter CRUD compatibility", () => {
  it("prepares sends without invoking the GitHub API", async () => {
    let providerCalls = 0;
    const adapter = new GithubAdapter({
      api: createGithubApi({
        createIssueComment: async () => {
          providerCalls += 1;
          return { id: 1 };
        },
      }),
    });
    const sessionRef = { platform: "github" as const, channelId: "octo/repo#12" };

    expect(
      await adapter.prepareSendMsg(sessionRef, {
        text: "prepared",
        attachmentCount: 0,
        actionCount: 0,
      }),
    ).toEqual(Result.ok(undefined));
    const unsupported = await adapter.prepareSendMsg(sessionRef, {
      text: "attachment",
      attachmentCount: 1,
      actionCount: 0,
    });
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "ok") throw new Error("expected unsupported attachment");
    expect(unsupported.error).toBeInstanceOf(SurfaceOperationUnsupported);
    expect(providerCalls).toBe(0);
  });

  it("preserves generic edit text verbatim and rejects attachment edits", async () => {
    const edits: Array<Parameters<GithubAdapterApi["editIssueComment"]>[0]> = [];
    const adapter = new GithubAdapter({
      api: createGithubApi({
        editIssueComment: async (input) => {
          edits.push(input);
        },
      }),
    });
    const ref = { platform: "github" as const, channelId: "octo/repo#12", messageId: "42" };

    expect(await adapter.editMsg(ref, { text: "verbatim tool text" })).toEqual(
      Result.ok(undefined),
    );
    expect(edits).toEqual([
      {
        owner: "octo",
        repo: "repo",
        commentId: 42,
        body: "verbatim tool text",
      },
    ]);

    const attachmentEdit = await adapter.editMsg(ref, {
      text: "replacement",
      attachments: [
        { kind: "file", filename: "report.txt", mimeType: "text/plain", bytes: new Uint8Array() },
      ],
    });
    expect(attachmentEdit.status).toBe("error");
    if (attachmentEdit.status === "ok") throw new Error("expected attachment edit failure");
    expect(attachmentEdit.error).toBeInstanceOf(SurfaceOperationUnsupported);
    expect(edits).toHaveLength(1);
  });

  it("sends and deletes comments with the expected GitHub request bodies", async () => {
    const creates: Array<Parameters<GithubAdapterApi["createIssueComment"]>[0]> = [];
    const deletes: Array<Parameters<GithubAdapterApi["deleteIssueComment"]>[0]> = [];
    const adapter = new GithubAdapter({
      api: createGithubApi({
        createIssueComment: async (input) => {
          creates.push(input);
          return { id: 73 };
        },
        deleteIssueComment: async (input) => {
          deletes.push(input);
        },
      }),
    });

    expect(
      await adapter.sendMsg(
        { platform: "github", channelId: "octo/repo#12" },
        { text: "new comment" },
      ),
    ).toEqual(Result.ok({ platform: "github", channelId: "octo/repo#12", messageId: "73" }));
    expect(creates).toEqual([
      {
        owner: "octo",
        repo: "repo",
        issueNumber: 12,
        body: `${GITHUB_AGENT_COMMENT_MARKER}\nnew comment`,
      },
    ]);

    expect(
      await adapter.deleteMsg({
        platform: "github",
        channelId: "octo/repo#12",
        messageId: "73",
      }),
    ).toEqual(Result.ok(undefined));
    expect(deletes).toEqual([{ owner: "octo", repo: "repo", commentId: 73 }]);
  });

  it("rejects send attachments without creating a comment", async () => {
    let creates = 0;
    const adapter = new GithubAdapter({
      api: createGithubApi({
        createIssueComment: async () => {
          creates += 1;
          return { id: 1 };
        },
      }),
    });

    const result = await adapter.sendMsg(
      { platform: "github", channelId: "octo/repo#12" },
      {
        text: "attached",
        attachments: [
          { kind: "file", filename: "report.txt", mimeType: "text/plain", bytes: new Uint8Array() },
        ],
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected attachment send failure");
    expect(result.error).toBeInstanceOf(SurfaceOperationUnsupported);
    expect(creates).toBe(0);
  });

  it("reports partial completion when action rendering fails after comment creation", async () => {
    const adapter = new GithubAdapter({
      api: createGithubApi({
        createIssueComment: async () => ({ id: 99 }),
        editIssueComment: async () => {
          throw new GithubApiError(503, "/comments/99", "edit unavailable");
        },
      }),
    });

    const result = await adapter.sendMsg(
      { platform: "github", channelId: "octo/repo#12" },
      {
        text: "Queued",
        actions: [{ actionId: "cancel", label: "Cancel", style: "danger" }],
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected partial completion");
    expect(result.error).toBeInstanceOf(SurfaceOperationPartiallyCompleted);
    expect(result.error).toMatchObject({
      operation: "send-message",
      created: { platform: "github", channelId: "octo/repo#12", messageId: "99" },
    });
  });

  it("renders actions in the follow-up edit while preserving the created ref", async () => {
    const edits: Array<Parameters<GithubAdapterApi["editIssueComment"]>[0]> = [];
    const adapter = new GithubAdapter({
      api: createGithubApi({
        createIssueComment: async () => ({ id: 100 }),
        editIssueComment: async (input) => {
          edits.push(input);
        },
      }),
    });

    const result = await adapter.sendMsg(
      { platform: "github", channelId: "octo/repo#12" },
      {
        text: "Queued",
        actions: [{ actionId: "cancel", label: "Cancel", style: "danger" }],
      },
    );

    expect(result).toEqual(
      Result.ok({ platform: "github", channelId: "octo/repo#12", messageId: "100" }),
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]?.body).toStartWith(`${GITHUB_AGENT_COMMENT_MARKER}\nQueued`);
    expect(edits[0]?.body).toContain("Cancel");
  });

  it("maps provider 404s to message not found", async () => {
    const missing = new GithubAdapter({
      api: createGithubApi({
        getIssueComment: async () => {
          throw new GithubApiError(404, "/comments/42", "missing");
        },
      }),
    });
    const missingResult = await missing.readMsg({
      platform: "github",
      channelId: "octo/repo#12",
      messageId: "42",
    });
    expect(missingResult.status).toBe("error");
    if (missingResult.status === "ok") throw new Error("expected missing comment");
    expect(missingResult.error).toBeInstanceOf(SurfaceMessageNotFound);
  });

  it("preserves zero timestamp fallbacks and the edited timestamp field", async () => {
    const adapter = new GithubAdapter({
      api: createGithubApi({
        listIssueComments: async () => [
          { id: 1, body: "missing timestamps" },
          { id: 2, body: "invalid timestamps", created_at: "invalid", updated_at: "invalid" },
          {
            id: 3,
            body: "valid timestamps",
            created_at: "2020-01-01T00:00:00.000Z",
            updated_at: "2020-01-02T00:00:00.000Z",
          },
        ],
      }),
    });

    const listed = await adapter.listMsg({ platform: "github", channelId: "octo/repo#12" });
    expect(listed.status).toBe("ok");
    if (listed.status === "error") throw listed.error;
    expect(listed.value.map(({ ts, editedTs }) => ({ ts, editedTs }))).toEqual([
      { ts: 0, editedTs: 0 },
      { ts: 0, editedTs: 0 },
      { ts: 1_577_836_800_000, editedTs: 1_577_923_200_000 },
    ]);
  });
});

describe("GitHub adapter reaction pagination", () => {
  it("lists and aggregates every issue reaction page", async () => {
    const listed: Array<Parameters<GithubAdapterApi["listIssueReactions"]>[0]> = [];
    const adapter = new GithubAdapter({
      api: createGithubApi({
        listIssueReactions: async (input) => {
          listed.push(input);
          if (input.page === 1) {
            return Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              content: "+1",
            }));
          }
          return [{ id: 101, content: "heart", user: { id: 7, login: "octocat" } }];
        },
        listIssueCommentReactions: async () => {
          throw new Error("comment reaction endpoint should not be called");
        },
      }),
    });

    const result = await adapter.listReactionDetails({
      platform: "github",
      channelId: "octo/repo#12",
      messageId: "12",
    });

    expect(result).toEqual(
      Result.ok([
        { emoji: "👍", count: 100, users: [] },
        { emoji: "❤️", count: 1, users: [{ userId: "7", userName: "octocat" }] },
      ]),
    );
    expect(listed).toEqual([
      { owner: "octo", repo: "repo", issueNumber: 12, limit: 100, page: 1 },
      { owner: "octo", repo: "repo", issueNumber: 12, limit: 100, page: 2 },
    ]);
  });

  it("lists all comment pages before deleting an actor-owned page-two reaction", async () => {
    const events: string[] = [];
    const deleted: Array<Parameters<GithubAdapterApi["deleteIssueCommentReactionById"]>[0]> = [];
    const adapter = new GithubAdapter({
      api: createGithubApi({
        getPreferredGithubActorLoginOrNull: async () => "lilac-bot",
        listIssueReactions: async () => {
          throw new Error("issue reaction endpoint should not be called");
        },
        listIssueCommentReactions: async (input) => {
          events.push(`list:${input.page}`);
          if (input.page === 1) {
            return Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              content: "heart",
              user: { login: "someone-else" },
            }));
          }
          if (input.page === 2) {
            return [
              { id: 200, content: "eyes", user: { login: "lilac-bot" } },
              ...Array.from({ length: 99 }, (_, index) => ({
                id: 201 + index,
                content: "eyes",
                user: { login: "someone-else" },
              })),
            ];
          }
          return [];
        },
        deleteIssueCommentReactionById: async (input) => {
          events.push(`delete:${input.reactionId}`);
          deleted.push(input);
        },
      }),
    });

    const result = await adapter.removeReaction(
      { platform: "github", channelId: "octo/repo#12", messageId: "42" },
      "eyes",
    );

    expect(result).toEqual(Result.ok(undefined));
    expect(events).toEqual(["list:1", "list:2", "list:3", "delete:200"]);
    expect(deleted).toEqual([{ owner: "octo", repo: "repo", commentId: 42, reactionId: 200 }]);
  });

  it("captures a later reaction page failure as the existing typed operation error", async () => {
    const pages: number[] = [];
    const adapter = new GithubAdapter({
      api: createGithubApi({
        listIssueReactions: async (input) => {
          pages.push(input.page ?? -1);
          if (input.page === 2) {
            throw new GithubApiError(503, "/repos/octo/repo/issues/12/reactions", "unavailable");
          }
          return Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            content: "+1",
          }));
        },
      }),
    });

    const result = await adapter.listReactions({
      platform: "github",
      channelId: "octo/repo#12",
      messageId: "12",
    });

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected reaction listing failure");
    expect(result.error).toBeInstanceOf(SurfaceUnavailable);
    expect(result.error).toMatchObject({ operation: "list-reactions" });
    expect(pages).toEqual([1, 2]);
  });
});

describe("GitHub adapter reply permalinks", () => {
  async function replyBody(api: Partial<GithubAdapterApi>): Promise<string> {
    const creates: string[] = [];
    const adapter = new GithubAdapter({
      api: createGithubApi({
        createIssueComment: async ({ body }) => {
          creates.push(body);
          return { id: 7 };
        },
        ...api,
      }),
    });
    const started = await adapter.startOutput(
      { platform: "github", channelId: "octo/repo#12" },
      { replyTo: { platform: "github", channelId: "octo/repo#12", messageId: "4152921803" } },
    );
    if (started.status === "error") throw started.error;
    await started.value.push({ type: "text.set", text: "Done" });
    const finished = await started.value.finish();
    if (finished.status === "error") throw finished.error;
    return creates[0] ?? "";
  }

  it("falls back to github.com when the API resolves no host", async () => {
    const body = await replyBody({});

    expect(body).toContain(
      "In reply to https://github.com/octo/repo/issues/12#issuecomment-4152921803:",
    );
  });
});

describe("GitHub normalized workflow progress port", () => {
  it("uses textual reply composition and workflow-owned markers", async () => {
    const creates: Array<Parameters<GithubAdapterApi["createIssueComment"]>[0]> = [];
    const edits: Array<Parameters<GithubAdapterApi["editIssueComment"]>[0]> = [];
    const adapter = new GithubAdapter({
      api: createGithubApi({
        createIssueComment: async (input) => {
          creates.push(input);
          return { id: 55 };
        },
        editIssueComment: async (input) => {
          edits.push(input);
        },
      }),
    });
    const port = createGithubWorkflowProgressPort(adapter, {
      getGithubWebBaseUrl: async () => "https://github.example.com",
    });

    const sent = await port.send({
      channelId: "octo/repo#12",
      replyToMessageId: "12",
      silent: true,
      content: { text: "Queued" },
    });
    expect(sent).toEqual(
      Result.ok({ platform: "github", channelId: "octo/repo#12", messageId: "55" }),
    );
    expect(creates[0]?.body).toBe(
      `${GITHUB_AGENT_COMMENT_MARKER}\nIn reply to https://github.example.com/octo/repo/issues/12:\n\nQueued`,
    );

    expect(
      await port.edit({ channelId: "octo/repo#12", messageId: "55" }, { text: "Running" }),
    ).toEqual(Result.ok(undefined));
    expect(edits[0]?.body).toBe(`${GITHUB_AGENT_COMMENT_MARKER}\nRunning`);
  });
});

describe("classifyGithubSurfaceError", () => {
  it.each([
    [404, SurfaceMessageNotFound],
    [403, SurfacePermissionDenied],
    [429, SurfaceRateLimited],
    [422, SurfaceInvalidInput],
    [503, SurfaceUnavailable],
  ] as const)("classifies recognized GitHub status %s", (status, ErrorType) => {
    const classified = classifyGithubSurfaceError(
      "read-message",
      new GithubApiError(status, "/repos/owner/repo/issues/comments/1", "failed"),
    );
    expect(classified).toBeInstanceOf(ErrorType);
    expect(classified).toMatchObject({ platform: "github", operation: "read-message" });
  });

  it("classifies authentication failures and leaves unknown defects unclassified", () => {
    expect(
      classifyGithubSurfaceError(
        "send-message",
        new GithubAuthFailed({ operation: "resolve", message: "auth failed" }),
      ),
    ).toBeInstanceOf(SurfaceUnavailable);
    expect(classifyGithubSurfaceError("send-message", new Error("unknown"))).toBeNull();
  });

  it("distinguishes GitHub 403 rate limits from permission failures", () => {
    const classified = classifyGithubSurfaceError(
      "send-message",
      new GithubApiError(403, "/repos/owner/repo/issues/1/comments", "secondary rate limit", {
        retryAfterMs: 2500,
      }),
    );

    expect(classified).toBeInstanceOf(SurfaceRateLimited);
    expect(classified).toMatchObject({ retryAfterMs: 2500 });
  });
});
