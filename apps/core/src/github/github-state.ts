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
  actorLogin?: string;
  superseded?: boolean;
  pr?: {
    prNumber: number;
    headSha: string;
    mode: "review";
    pendingInterrupt?: { requestId: string; requestDeliveryId: string };
  };
};

export type GithubAckState = {
  target: ReactionTarget;
  reactionId: number;
};

export type GithubAcknowledgementClaim =
  | { kind: "unclaimed" }
  | {
      kind: "already-owned";
      requestId: string;
      acknowledgement: GithubAckState;
    }
  | {
      kind: "transferred";
      previousRequestId: string;
      requestId: string;
      acknowledgement: GithubAckState;
    };

export type GithubLatestRequestTransition = {
  sessionId: string;
  requestId: string;
  previousRequestId: string | undefined;
  previousWasSuperseded?: boolean;
};

const latestBySession = new Map<string, string>();
const metaByRequest = new Map<string, GithubRequestMeta>();
const ackByRequest = new Map<string, GithubAckState>();

export function setGithubLatestRequestForSession(
  sessionId: string,
  requestId: string,
): GithubLatestRequestTransition {
  const previousRequestId = latestBySession.get(sessionId);
  const previousMeta = previousRequestId ? metaByRequest.get(previousRequestId) : undefined;
  const previousWasSuperseded = previousMeta?.superseded;
  if (previousMeta && previousRequestId !== requestId) previousMeta.superseded = true;
  latestBySession.set(sessionId, requestId);
  return { sessionId, requestId, previousRequestId, previousWasSuperseded };
}

export function getGithubLatestRequestForSession(sessionId: string): string | undefined {
  return latestBySession.get(sessionId);
}

export function restoreGithubLatestRequestForSession(
  transition: GithubLatestRequestTransition,
): boolean {
  if (latestBySession.get(transition.sessionId) !== transition.requestId) return false;

  if (transition.previousRequestId) {
    const previousMeta = metaByRequest.get(transition.previousRequestId);
    if (previousMeta) previousMeta.superseded = transition.previousWasSuperseded;
    latestBySession.set(transition.sessionId, transition.previousRequestId);
  } else {
    latestBySession.delete(transition.sessionId);
  }
  return true;
}

export function setGithubRequestMeta(meta: GithubRequestMeta) {
  metaByRequest.set(meta.requestId, {
    ...meta,
    superseded: metaByRequest.get(meta.requestId)?.superseded,
  });
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

export function claimGithubAcknowledgement(
  previousRequestId: string | undefined,
  requestId: string,
): GithubAcknowledgementClaim {
  const existing = ackByRequest.get(requestId);
  if (existing) {
    return {
      kind: "already-owned",
      requestId,
      acknowledgement: existing,
    };
  }
  if (!previousRequestId || previousRequestId === requestId) return { kind: "unclaimed" };

  const acknowledgement = ackByRequest.get(previousRequestId);
  if (!acknowledgement) return { kind: "unclaimed" };

  ackByRequest.set(requestId, acknowledgement);
  ackByRequest.delete(previousRequestId);
  return {
    kind: "transferred",
    previousRequestId,
    requestId,
    acknowledgement,
  };
}

export function rollbackGithubAcknowledgementClaim(claim: GithubAcknowledgementClaim): boolean {
  if (claim.kind !== "transferred") return false;
  if (ackByRequest.get(claim.requestId) !== claim.acknowledgement) return false;
  if (ackByRequest.has(claim.previousRequestId)) return false;

  ackByRequest.delete(claim.requestId);
  ackByRequest.set(claim.previousRequestId, claim.acknowledgement);
  return true;
}

export function clearGithubRequest(requestId: string): void {
  const meta = metaByRequest.get(requestId);
  if (meta && latestBySession.get(meta.sessionId) === requestId)
    latestBySession.delete(meta.sessionId);
  metaByRequest.delete(requestId);
  ackByRequest.delete(requestId);
}
