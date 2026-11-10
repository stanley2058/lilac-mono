import { expect, it } from "bun:test";
import {
  clearGithubRequest,
  getGithubAck,
  getGithubLatestRequestForSession,
  getGithubRequestMeta,
  setGithubAck,
  setGithubLatestRequestForSession,
  setGithubRequestMeta,
} from "../../src/github/github-state";

it("prunes terminal request metadata without clearing a newer session owner", () => {
  const sessionId = "state-test/repo#1";
  for (const requestId of ["old", "new"]) {
    setGithubRequestMeta({
      requestId,
      sessionId,
      repoFullName: "state-test/repo",
      issueNumber: 1,
      trigger: { kind: "issue", issueNumber: 1 },
      createdAtMs: Date.now(),
    });
    setGithubLatestRequestForSession(sessionId, requestId);
    setGithubAck(requestId, { target: { kind: "issue", issueNumber: 1 }, reactionId: 1 });
  }
  clearGithubRequest("old");
  expect(getGithubRequestMeta("old")).toBeUndefined();
  expect(getGithubAck("old")).toBeUndefined();
  expect(getGithubLatestRequestForSession(sessionId)).toBe("new");
  clearGithubRequest("new");
  expect(getGithubLatestRequestForSession(sessionId)).toBeUndefined();
});

it("retains supersession on an older active request after the replacement finishes", () => {
  const sessionId = "state-test/repo#2";
  for (const requestId of ["active-old", "finished-new"]) {
    setGithubRequestMeta({
      requestId,
      sessionId,
      repoFullName: "state-test/repo",
      issueNumber: 2,
      trigger: { kind: "issue", issueNumber: 2 },
      createdAtMs: Date.now(),
    });
    setGithubLatestRequestForSession(sessionId, requestId);
  }
  clearGithubRequest("finished-new");
  expect(getGithubLatestRequestForSession(sessionId)).toBeUndefined();
  expect(getGithubRequestMeta("active-old")?.superseded).toBe(true);
  clearGithubRequest("active-old");
});
