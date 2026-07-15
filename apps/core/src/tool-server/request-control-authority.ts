import { createHash, randomBytes } from "node:crypto";

type SafetyMode = "trusted" | "restricted";

type RequestControlPolicyBase = {
  requestId: string;
  sessionId: string;
  platform: string;
  canonicalCwd: string;
  safetyMode: SafetyMode;
  expiresAt: number;
};

export const HEARTBEAT_LEVEL2_CALLABLES = [
  "fetch",
  "search",
  "discovery.search",
  "conversation.thread.search",
  "conversation.thread.metadata",
  "conversation.thread.read",
  "surface.sessions.list",
  "surface.sessions.listParticipants",
  "surface.messages.list",
  "surface.messages.read",
  "surface.messages.search",
  "surface.messages.send",
] as const;

export type RequestControlPolicy = RequestControlPolicyBase &
  (
    | {
        kind: "primary";
        principal: { platform: "discord" | "github"; userId: string };
        allowedCallables: null;
      }
    | {
        kind: "heartbeat";
        principal: null;
        allowedCallables: readonly string[];
      }
  );

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class RequestControlAuthority {
  private readonly byTokenHash = new Map<string, RequestControlPolicy>();
  private readonly tokenHashByRequest = new Map<string, string>();

  issue(policy: RequestControlPolicy): string {
    this.expire(policy.requestId);
    const token = randomBytes(32).toString("base64url");
    const hash = tokenHash(token);
    this.byTokenHash.set(hash, policy);
    this.tokenHashByRequest.set(policy.requestId, hash);
    return token;
  }

  authorize(input: {
    token: string;
    requestId: string;
    sessionId: string;
    platform: string;
    now: number;
  }): RequestControlPolicy | null {
    const hash = tokenHash(input.token);
    const policy = this.byTokenHash.get(hash);
    if (
      !policy ||
      this.tokenHashByRequest.get(input.requestId) !== hash ||
      policy.expiresAt <= input.now ||
      policy.requestId !== input.requestId ||
      policy.sessionId !== input.sessionId ||
      policy.platform !== input.platform
    ) {
      return null;
    }
    return policy;
  }

  expire(requestId: string): void {
    const hash = this.tokenHashByRequest.get(requestId);
    if (hash) this.byTokenHash.delete(hash);
    this.tokenHashByRequest.delete(requestId);
  }
}
