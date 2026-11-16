import type { AdapterPlatform, LilacMessageForTopic } from "@stanley2058/lilac-event-bus";
import { isRecord } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { getBuiltinSurfaceProtocol } from "./builtin-surface-protocols";
import type {
  CorrelatedSurfaceRequestMetadata,
  GithubTriggerProjection,
  NativeRequestMetadata,
  SurfaceProtocolRequestMetadata,
  SurfaceProtocolRouting,
} from "./protocol";
import type {
  AuthenticatedSurfaceOrigin,
  AuthenticatedSurfaceOriginFor,
  MsgRefFor,
  RegisteredSurfacePlatform,
  SessionRefFor,
  SurfacePrincipal,
} from "./types";

export type AuthenticationMetadataKind =
  | "absent"
  | "actor"
  | "origin"
  | "actor-origin"
  | "github-trigger"
  | "actor-github-trigger"
  | "origin-github-trigger"
  | "actor-origin-github-trigger";

type AuthenticationMetadataPresence = {
  readonly actor: boolean;
  readonly origin: boolean;
  readonly githubTrigger: boolean;
};

export type AuthenticatedRequestProjection = {
  readonly requestId: string;
  readonly requestClient: AdapterPlatform;
  readonly sessionId: string;
  readonly source: "external" | "internal-delegated";
  readonly platform?: RegisteredSurfacePlatform;
  readonly sessionRef?: SessionRefFor<RegisteredSurfacePlatform>;
  readonly messageRef?: MsgRefFor<RegisteredSurfacePlatform>;
  readonly authenticatedActor?: SurfacePrincipal;
  readonly authenticatedOrigin?: AuthenticatedSurfaceOrigin;
  readonly authenticationMetadataKind: AuthenticationMetadataKind;
  readonly githubTrigger?: GithubTriggerProjection;
  readonly native?: NativeRequestMetadata;
  readonly verifiedIngress: boolean;
};

export type AuthenticatedRequestProjectionFor<P extends RegisteredSurfacePlatform> = Omit<
  AuthenticatedRequestProjection,
  | "requestClient"
  | "platform"
  | "sessionRef"
  | "messageRef"
  | "authenticatedActor"
  | "authenticatedOrigin"
> & {
  readonly requestClient: P;
  readonly platform: P;
  readonly sessionRef: SessionRefFor<P>;
  readonly messageRef?: MsgRefFor<P>;
  readonly authenticatedActor?: SurfacePrincipal & { readonly platform: P };
  readonly authenticatedOrigin?: Extract<AuthenticatedSurfaceOrigin, { platform: P }>;
};

export class AuthenticatedRequestProjectionInvalid extends TaggedError(
  "AuthenticatedRequestProjectionInvalid",
)<{
  readonly messageType: string;
  readonly message: string;
}> {}

export class AuthenticatedRequestIdentityConflict extends TaggedError(
  "AuthenticatedRequestIdentityConflict",
)<{
  readonly messageType: string;
  readonly message: string;
}> {}

const requestRawSchema = z
  .object({
    authenticatedActor: z
      .object({
        platform: z.string().trim().min(1),
        userId: z.string().trim().min(1),
      })
      .optional(),
    authenticatedOrigin: z
      .object({
        platform: z.string().trim().min(1),
        userId: z.string().trim().min(1),
        messageRef: z.object({
          platform: z.string().trim().min(1),
          channelId: z.string().trim().min(1),
          messageId: z.string().trim().min(1),
        }),
      })
      .optional(),
    native: z
      .strictObject({
        compact: z.boolean().optional(),
        threadId: z.string().regex(/^[^:\s]+$/u),
        authorUserId: z.string().trim().min(1),
        starterUserId: z.string().trim().min(1),
        turnId: z.string().trim().min(1),
        historyGeneration: z.number().int().nonnegative(),
        inputId: z.string().trim().min(1),
        requestId: z.string().trim().min(1),
        requestDeliveryId: z.uuid(),
      })
      .optional(),
    github: z
      .object({
        repoFullName: z.string().trim().min(1).optional(),
        issueNumber: z.number().int().positive().optional(),
        prNumber: z.number().int().positive().optional(),
        trigger: z.union([
          z.object({ kind: z.literal("comment"), commentId: z.number().int().positive() }),
          z.object({ kind: z.literal("issue"), issueNumber: z.number().int().positive() }),
        ]),
      })
      .optional(),
  })
  .loose();

export function parseNativeRequestMetadata(raw: unknown): NativeRequestMetadata | null {
  const decoded = requestRawSchema.safeParse(raw);
  return decoded.success ? (decoded.data.native ?? null) : null;
}

export function parseNativeRequestEnvelope(request: {
  readonly raw?: unknown;
}): NativeRequestMetadata | null {
  return parseNativeRequestMetadata(request.raw);
}

type RequestRaw = z.output<typeof requestRawSchema>;
type RequestMessage = Extract<LilacMessageForTopic<"cmd.request">, { type: "cmd.request.message" }>;

type RequestRoute =
  | {
      readonly kind: "uncorrelated";
      readonly requestClient: AdapterPlatform;
    }
  | {
      readonly kind: "unregistered";
      readonly requestId: string;
      readonly requestClient: AdapterPlatform;
      readonly sessionId: string;
    }
  | {
      readonly kind: "registered";
      readonly requestId: string;
      readonly requestClient: RegisteredSurfacePlatform;
      readonly sessionId: string;
    };

function invalidProjection(
  messageType: string,
  message: string,
): ResultType<never, AuthenticatedRequestProjectionInvalid> {
  return Result.err(new AuthenticatedRequestProjectionInvalid({ messageType, message }));
}

function metadataPresence(kind: AuthenticationMetadataKind): AuthenticationMetadataPresence {
  switch (kind) {
    case "absent":
      return { actor: false, origin: false, githubTrigger: false };
    case "actor":
      return { actor: true, origin: false, githubTrigger: false };
    case "origin":
      return { actor: false, origin: true, githubTrigger: false };
    case "actor-origin":
      return { actor: true, origin: true, githubTrigger: false };
    case "github-trigger":
      return { actor: false, origin: false, githubTrigger: true };
    case "actor-github-trigger":
      return { actor: true, origin: false, githubTrigger: true };
    case "origin-github-trigger":
      return { actor: false, origin: true, githubTrigger: true };
    case "actor-origin-github-trigger":
      return { actor: true, origin: true, githubTrigger: true };
  }
}

function metadataKind(input: AuthenticationMetadataPresence): AuthenticationMetadataKind {
  if (input.actor && input.origin && input.githubTrigger) return "actor-origin-github-trigger";
  if (input.actor && input.githubTrigger) return "actor-github-trigger";
  if (input.origin && input.githubTrigger) return "origin-github-trigger";
  if (input.githubTrigger) return "github-trigger";
  if (input.actor && input.origin) return "actor-origin";
  if (input.actor) return "actor";
  if (input.origin) return "origin";
  return "absent";
}

function nonempty(value: string): boolean {
  return value.trim().length > 0;
}

function resolveRequestRoute(message: RequestMessage): RequestRoute {
  const requestId = message.headers?.request_id;
  const sessionId = message.headers?.session_id;
  const requestClient = message.headers?.request_client ?? "unknown";
  if (!requestId || !sessionId) return { kind: "uncorrelated", requestClient };

  const protocol = getBuiltinSurfaceProtocol(requestClient);
  return protocol
    ? { kind: "registered", requestId, requestClient: protocol.platform, sessionId }
    : { kind: "unregistered", requestId, requestClient, sessionId };
}

function validateSurfaceClaims(
  platform: RegisteredSurfacePlatform,
  sessionId: string,
  raw: RequestRaw,
  messageType: string,
): ResultType<void, AuthenticatedRequestProjectionInvalid> {
  const actor = raw.authenticatedActor;
  const origin = raw.authenticatedOrigin;
  const channelId = getBuiltinSurfaceProtocol(platform).refs.createSessionRef(sessionId).channelId;
  if (actor && actor.platform !== platform) {
    return invalidProjection(
      messageType,
      "authenticated actor platform does not match request headers",
    );
  }
  if (
    origin &&
    (origin.platform !== platform ||
      origin.messageRef.platform !== platform ||
      origin.messageRef.channelId !== channelId)
  ) {
    return invalidProjection(
      messageType,
      "authenticated origin does not match request headers and session",
    );
  }
  if (actor && origin && actor.userId !== origin.userId) {
    return invalidProjection(messageType, "authenticated actor and origin user IDs conflict");
  }
  return Result.ok(undefined);
}

function projectUnregisteredRequest(
  route: Extract<RequestRoute, { kind: "unregistered" }>,
): AuthenticatedRequestProjection {
  return {
    requestId: route.requestId,
    requestClient: route.requestClient,
    sessionId: route.sessionId,
    source: "external",
    authenticationMetadataKind: "absent",
    verifiedIngress: false,
  };
}

function projectRegisteredRequest<P extends RegisteredSurfacePlatform>(
  route: Extract<RequestRoute, { kind: "registered" }> & { readonly requestClient: P },
  protocol: SurfaceProtocolRouting<P>,
  raw: RequestRaw,
  messageType: string,
): ResultType<AuthenticatedRequestProjection, AuthenticatedRequestProjectionInvalid> {
  const claims = validateSurfaceClaims(protocol.platform, route.sessionId, raw, messageType);
  if (claims.isErr()) return Result.err(claims.error);
  const actor = raw.authenticatedActor;
  const origin = raw.authenticatedOrigin;
  const common = {
    ...(actor ? { actor: { platform: protocol.platform, userId: actor.userId } } : {}),
    ...(origin
      ? {
          origin: {
            platform: protocol.platform,
            userId: origin.userId,
            messageId: origin.messageRef.messageId,
          },
        }
      : {}),
    ...(raw.github ? { github: raw.github } : {}),
    ...(raw.native ? { native: raw.native } : {}),
  } satisfies CorrelatedSurfaceRequestMetadata<P>;
  const sessionRef = protocol.refs.createSessionRef(route.sessionId);
  if (raw.github && !protocol.requestProjection?.acceptsGithubMetadata) {
    return invalidProjection(
      messageType,
      "GitHub trigger metadata does not match the request platform",
    );
  }
  if (raw.native && !protocol.requestProjection?.acceptsNativeMetadata) {
    return invalidProjection(
      messageType,
      "Native request metadata does not match the request platform",
    );
  }
  const projectedProtocolMetadata: ResultType<
    SurfaceProtocolRequestMetadata | undefined,
    AuthenticatedRequestProjectionInvalid
  > =
    protocol.requestProjection?.projectProtocolMetadata?.({
      requestId: route.requestId,
      sessionRef,
      common,
      messageType,
      invalidProjection: (message) => invalidProjection(messageType, message),
    }) ?? Result.ok(undefined);
  if (projectedProtocolMetadata.isErr()) return Result.err(projectedProtocolMetadata.error);
  const protocolMetadata = projectedProtocolMetadata.value;
  let messageRef: MsgRefFor<P> | undefined;
  if (origin) {
    messageRef = protocol.refs.createMessageRef(sessionRef, origin.messageRef.messageId);
  } else if (protocolMetadata?.inferredMessageId) {
    messageRef = protocol.refs.createMessageRef(sessionRef, protocolMetadata.inferredMessageId);
  } else if (protocol.requestProjection?.inferRequestMessageRef) {
    const inferred = protocol.refs.resolveRequestMessageRef({
      requestId: route.requestId,
      sessionRef,
    });
    if (inferred.kind === "target") messageRef = inferred.ref;
  }

  const userId = origin?.userId ?? actor?.userId;
  const authenticatedOrigin: AuthenticatedSurfaceOriginFor<P> | undefined = userId
    ? {
        platform: protocol.platform,
        userId,
        sessionRef,
        ...(messageRef ? { messageRef } : {}),
      }
    : undefined;
  const githubTrigger = protocolMetadata?.githubTrigger;
  const projection = {
    requestId: route.requestId,
    requestClient: route.requestClient,
    sessionId: route.sessionId,
    source: "external",
    platform: protocol.platform,
    sessionRef,
    ...(messageRef ? { messageRef } : {}),
    ...(actor ? { authenticatedActor: { platform: protocol.platform, userId: actor.userId } } : {}),
    ...(authenticatedOrigin ? { authenticatedOrigin } : {}),
    authenticationMetadataKind: metadataKind({
      actor: actor !== undefined,
      origin: origin !== undefined,
      githubTrigger: githubTrigger !== undefined,
    }),
    ...(githubTrigger ? { githubTrigger } : {}),
    ...(protocolMetadata?.native ? { native: protocolMetadata.native } : {}),
    verifiedIngress:
      protocolMetadata?.verifiedIngress ?? (actor !== undefined || origin !== undefined),
  } as AuthenticatedRequestProjection;
  return Result.ok(projection);
}

function hasConsistentMetadataState(projection: AuthenticatedRequestProjection): boolean {
  const expected = metadataPresence(projection.authenticationMetadataKind);
  const actor = projection.authenticatedActor;
  const origin = projection.authenticatedOrigin;
  if (expected.actor !== (actor !== undefined)) return false;
  if (expected.githubTrigger !== (projection.githubTrigger !== undefined)) return false;
  if (expected.actor && origin === undefined) return false;
  if (expected.origin && origin === undefined) return false;
  return expected.actor || expected.origin || origin === undefined;
}

function isInternalDelegatedProjectionValid(projection: AuthenticatedRequestProjection): boolean {
  const origin = projection.authenticatedOrigin;
  if (
    projection.requestClient !== "unknown" ||
    projection.platform !== undefined ||
    projection.sessionRef !== undefined ||
    projection.messageRef !== undefined ||
    projection.authenticatedActor !== undefined ||
    projection.githubTrigger !== undefined ||
    projection.native !== undefined ||
    metadataPresence(projection.authenticationMetadataKind).actor ||
    projection.verifiedIngress
  ) {
    return false;
  }
  if (!origin) return true;
  return (
    nonempty(origin.userId) &&
    nonempty(origin.sessionRef.channelId) &&
    origin.sessionRef.platform === origin.platform
  );
}

function isUnregisteredExternalProjectionValid(
  projection: AuthenticatedRequestProjection,
): boolean {
  return (
    projection.authenticationMetadataKind === "absent" &&
    projection.platform === undefined &&
    projection.sessionRef === undefined &&
    projection.messageRef === undefined &&
    projection.authenticatedActor === undefined &&
    projection.authenticatedOrigin === undefined &&
    projection.githubTrigger === undefined &&
    projection.native === undefined &&
    !projection.verifiedIngress
  );
}

function hasValidRegisteredRoute(
  projection: AuthenticatedRequestProjection,
  platform: RegisteredSurfacePlatform,
): boolean {
  const sessionRef = projection.sessionRef;
  const messageRef = projection.messageRef;
  const channelId = getBuiltinSurfaceProtocol(platform).refs.createSessionRef(
    projection.sessionId,
  ).channelId;
  if (
    projection.platform !== platform ||
    sessionRef?.platform !== platform ||
    sessionRef.channelId !== channelId ||
    !nonempty(sessionRef.channelId)
  ) {
    return false;
  }
  return (
    messageRef === undefined ||
    (messageRef.platform === platform &&
      messageRef.channelId === channelId &&
      nonempty(messageRef.messageId))
  );
}

function hasValidRegisteredIdentity(
  projection: AuthenticatedRequestProjection,
  platform: RegisteredSurfacePlatform,
): boolean {
  const expected = metadataPresence(projection.authenticationMetadataKind);
  const actor = projection.authenticatedActor;
  const origin = projection.authenticatedOrigin;
  const channelId = getBuiltinSurfaceProtocol(platform).refs.createSessionRef(
    projection.sessionId,
  ).channelId;
  if (
    actor &&
    (actor.platform !== platform || !nonempty(actor.userId) || actor.userId !== origin?.userId)
  ) {
    return false;
  }
  if (expected.origin && origin?.messageRef === undefined) return false;
  if (!origin) return true;
  if (
    origin.platform !== platform ||
    origin.sessionRef.platform !== origin.platform ||
    origin.sessionRef.channelId !== channelId ||
    !nonempty(origin.userId)
  ) {
    return false;
  }
  const originMessageRef = origin.messageRef;
  if (!originMessageRef) return true;
  return (
    originMessageRef.platform === platform &&
    originMessageRef.channelId === channelId &&
    originMessageRef.messageId === projection.messageRef?.messageId
  );
}

function isRegisteredExternalProjectionValid(
  projection: AuthenticatedRequestProjection,
  protocol: SurfaceProtocolRouting<RegisteredSurfacePlatform>,
): boolean {
  const platform = protocol.platform;
  if (!hasValidRegisteredRoute(projection, platform)) return false;
  if (!hasValidRegisteredIdentity(projection, platform)) return false;
  if (
    projection.githubTrigger !== undefined &&
    !protocol.requestProjection?.acceptsGithubMetadata
  ) {
    return false;
  }
  if (projection.native !== undefined && !protocol.requestProjection?.acceptsNativeMetadata)
    return false;
  return (
    protocol.requestProjection?.isProtocolProjectionValid?.(
      projection as AuthenticatedRequestProjectionFor<RegisteredSurfacePlatform>,
    ) ?? true
  );
}

export function isAuthenticatedRequestProjectionSemanticallyValid(
  projection: AuthenticatedRequestProjection,
): boolean {
  if (!nonempty(projection.requestId) || !nonempty(projection.sessionId)) return false;
  if (!hasConsistentMetadataState(projection)) return false;
  if (projection.source === "internal-delegated") {
    return isInternalDelegatedProjectionValid(projection);
  }
  const protocol = getBuiltinSurfaceProtocol(projection.requestClient);
  return protocol
    ? isRegisteredExternalProjectionValid(projection, protocol)
    : isUnregisteredExternalProjectionValid(projection);
}

export function isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid(
  projection: AuthenticatedRequestProjection,
): boolean {
  if (!isAuthenticatedRequestProjectionSemanticallyValid(projection)) return false;
  if (projection.source === "internal-delegated") return true;
  const protocol = getBuiltinSurfaceProtocol(projection.requestClient);
  return (
    protocol?.requestProjection?.hasDurableProtocolProof?.(
      projection as AuthenticatedRequestProjectionFor<RegisteredSurfacePlatform>,
    ) ?? true
  );
}

function requireSemanticallyValidProjection(
  projected: ResultType<AuthenticatedRequestProjection, AuthenticatedRequestProjectionInvalid>,
  messageType: string,
): ResultType<AuthenticatedRequestProjection, AuthenticatedRequestProjectionInvalid> {
  return projected.andThen((projection) =>
    isAuthenticatedRequestProjectionSemanticallyValid(projection)
      ? Result.ok(projection)
      : invalidProjection(
          messageType,
          "cmd.request.message authentication projection is semantically inconsistent",
        ),
  );
}

export function projectAuthenticatedRequest(
  message: RequestMessage,
): ResultType<AuthenticatedRequestProjection | undefined, AuthenticatedRequestProjectionInvalid> {
  const raw = message.data.raw;
  const metadataClaimed =
    isRecord(raw) &&
    (Object.hasOwn(raw, "authenticatedActor") ||
      Object.hasOwn(raw, "authenticatedOrigin") ||
      Object.hasOwn(raw, "github") ||
      Object.hasOwn(raw, "native"));
  const route = resolveRequestRoute(message);
  if (route.kind === "uncorrelated") {
    if (!metadataClaimed) return Result.ok(undefined);
    return invalidProjection(
      message.type,
      "cmd.request.message authentication metadata requires correlated surface headers",
    );
  }
  if (route.kind === "unregistered") {
    if (metadataClaimed) {
      return invalidProjection(
        message.type,
        "surface authentication metadata requires a registered request platform",
      );
    }
    return requireSemanticallyValidProjection(
      Result.ok(projectUnregisteredRequest(route)),
      message.type,
    );
  }

  const decoded = requestRawSchema.safeParse(raw);
  if (!decoded.success && metadataClaimed) {
    return invalidProjection(
      message.type,
      "cmd.request.message contains invalid authentication metadata",
    );
  }
  const metadata = decoded.success ? decoded.data : {};
  if (
    metadata.native &&
    (metadata.native.requestId !== route.requestId ||
      metadata.native.requestDeliveryId !== message.data.requestDeliveryId)
  ) {
    return invalidProjection(
      message.type,
      "Native delivery identity does not match request headers and data",
    );
  }

  const protocol = getBuiltinSurfaceProtocol(route.requestClient);
  if (!protocol) {
    return invalidProjection(
      message.type,
      "surface authentication metadata requires a registered request platform",
    );
  }
  return requireSemanticallyValidProjection(
    projectRegisteredRequest(route, protocol, metadata, message.type),
    message.type,
  );
}

function sameGithubTrigger(
  left: GithubTriggerProjection | undefined,
  right: GithubTriggerProjection | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.kind === right.kind &&
    left.targetKind === right.targetKind &&
    left.repoFullName === right.repoFullName &&
    left.issueNumber === right.issueNumber &&
    left.messageId === right.messageId
  );
}

function hasUnprovenGithubOriginMessageReplacement(
  previous: AuthenticatedRequestProjection,
  next: AuthenticatedRequestProjection,
): boolean {
  if (previous.requestClient !== "github" || next.requestClient !== "github") return false;
  const previousMessageRef = previous.authenticatedOrigin?.messageRef;
  const nextMessageRef = next.authenticatedOrigin?.messageRef;
  if (!previousMessageRef || !nextMessageRef) return false;
  if (previousMessageRef.messageId === nextMessageRef.messageId) return false;
  return next.githubTrigger?.messageId !== nextMessageRef.messageId;
}

type LatchConflictReason =
  | "request-changed"
  | "client-changed"
  | "session-changed"
  | "origin-introduced"
  | "verification-upgraded"
  | "github-origin-message-replaced"
  | "github-trigger-changed"
  | "native-principal-changed";

function latchConflictReason(
  previous: AuthenticatedRequestProjection,
  next: AuthenticatedRequestProjection,
): LatchConflictReason | undefined {
  if (
    previous.native?.starterUserId !== next.native?.starterUserId ||
    previous.native?.threadId !== next.native?.threadId ||
    previous.native?.turnId !== next.native?.turnId ||
    previous.native?.historyGeneration !== next.native?.historyGeneration
  )
    return "native-principal-changed";
  if (previous.requestId !== next.requestId) return "request-changed";
  if (previous.requestClient !== next.requestClient) return "client-changed";
  if (previous.sessionId !== next.sessionId) return "session-changed";
  if (!previous.authenticatedOrigin && next.authenticatedOrigin) return "origin-introduced";
  if (!previous.verifiedIngress && next.verifiedIngress) return "verification-upgraded";
  if (hasUnprovenGithubOriginMessageReplacement(previous, next)) {
    return "github-origin-message-replaced";
  }
  if (
    previous.verifiedIngress &&
    next.githubTrigger !== undefined &&
    !sameGithubTrigger(previous.githubTrigger, next.githubTrigger)
  ) {
    return "github-trigger-changed";
  }
  return undefined;
}

export function latchAuthenticatedRequest(
  previous: AuthenticatedRequestProjection | undefined,
  next: AuthenticatedRequestProjection,
  messageType: string,
): ResultType<AuthenticatedRequestProjection, AuthenticatedRequestIdentityConflict> {
  if (!previous) return Result.ok(next);
  if (latchConflictReason(previous, next)) {
    return Result.err(
      new AuthenticatedRequestIdentityConflict({
        messageType,
        message: "request follow-up conflicts with its first accepted authentication state",
      }),
    );
  }
  return Result.ok(previous);
}
