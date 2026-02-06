type ReactionTarget =
  | { kind: "issue"; issueNumber: number }
  | { kind: "comment"; commentId: number; issueNumber: number };

export type GithubRequestMeta = {
  requestId: string;
  sessionId: string;
  repoFullName: string;
  issueNumber: number;
  trigger: ReactionTarget;
  createdAtMs: number;
  pr?: {
    prNumber: number;
    headSha: string;
    mode: "review";
  };
};

export type GithubAckState = {
  target: ReactionTarget;
  reactionId: number;
};

const latestBySession = new Map<string, string>();
const metaByRequest = new Map<string, GithubRequestMeta>();
const ackByRequest = new Map<string, GithubAckState>();

export function setGithubLatestRequestForSession(sessionId: string, requestId: string) {
  latestBySession.set(sessionId, requestId);
}

export function getGithubLatestRequestForSession(sessionId: string): string | undefined {
  return latestBySession.get(sessionId);
}

export function setGithubRequestMeta(meta: GithubRequestMeta) {
  metaByRequest.set(meta.requestId, meta);
}

export function getGithubRequestMeta(requestId: string): GithubRequestMeta | undefined {
  return metaByRequest.get(requestId);
}

export function setGithubAck(requestId: string, ack: GithubAckState) {
  ackByRequest.set(requestId, ack);
}

export function getGithubAck(requestId: string): GithubAckState | undefined {
  return ackByRequest.get(requestId);
}

export function clearGithubAck(requestId: string) {
  ackByRequest.delete(requestId);
}
