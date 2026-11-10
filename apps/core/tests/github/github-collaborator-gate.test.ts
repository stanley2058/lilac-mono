import { describe, expect, it } from "bun:test";
import {
  isGithubCommenterTrusted,
  rejectGithubCommenterOnce,
} from "../../src/github/webhook/github-webhook-server";

describe("GitHub collaborator gate", () => {
  it("accepts collaborator associations without a permission lookup", async () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(
        await isGithubCommenterTrusted({
          association,
          login: "stanley",
          checkPermission: async () => {
            throw new Error("unexpected lookup");
          },
        }),
      ).toBe(true);
    }
  });
  it("checks permissions for private members and rejects other commenters", async () => {
    expect(
      await isGithubCommenterTrusted({
        association: "CONTRIBUTOR",
        login: "private-member",
        checkPermission: async (login) => login === "private-member",
      }),
    ).toBe(true);
    expect(
      await isGithubCommenterTrusted({
        association: "NONE",
        login: "outsider",
        checkPermission: async () => false,
      }),
    ).toBe(false);
    expect(
      await isGithubCommenterTrusted({ association: "OWNER", checkPermission: async () => true }),
    ).toBe(false);
  });
});

it("reuses a recorded rejection for the same issue commenter", async () => {
  const comments: Array<{ body?: string }> = [];
  const input = {
    login: "outsider",
    listComments: async () => comments,
    reply: async (body: string) => {
      comments.push({ body });
    },
  };
  await rejectGithubCommenterOnce(input);
  await rejectGithubCommenterOnce(input);
  expect(comments).toHaveLength(1);
  expect(comments[0]?.body).toContain("@outsider");
});
